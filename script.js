const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;

// Configuração do Pool de Conexões do MySQL
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'sao.domcloud.co',
    user: process.env.DB_USER || 'calendario',
    password: process.env.DB_PASSWORD || 'Nz92xbL5BiQ(-sX37-',
    database: process.env.DB_NAME || 'calendario_calendario',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Auxiliares para converter tempo e calcular o término da tarefa
function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // Rota de entrega do HTML com tratamento de erro robusto
    if (pathname === '/' && method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Erro interno: Não foi possível carregar o arquivo index.html.');
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
    } 
    // Rota de entrega do CSS com tratamento de erro corrigido (Evita quebrar o app se o arquivo falhar)
    else if (pathname === '/style.css' && method === 'GET') {
        fs.readFile(path.join(__dirname, 'style.css'), (err, content) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Arquivo CSS não encontrado.');
            }
            res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
            res.end(content);
        });
    } 
    // API GET: Buscar tarefas filtradas por mês e ano (Otimização de Performance)
    else if (pathname === '/api/tasks' && method === 'GET') {
        try {
            const month = parsedUrl.searchParams.get('month');
            const year = parsedUrl.searchParams.get('year');

            let query = `
                SELECT 
                    id, 
                    DATE_FORMAT(date, "%Y-%m-%d") as date, 
                    task_type as taskType,
                    first_name as firstName,
                    description, 
                    TIME_FORMAT(start_time, "%H:%i") as startTime, 
                    duration_minutes as durationMinutes, 
                    TIME_FORMAT(end_time, "%H:%i") as endTime 
                FROM tasks
            `;
            const params = [];

            if (month && year) {
                query += " WHERE MONTH(date) = ? AND YEAR(date) = ?";
                params.push(month, year);
            }

            const [rows] = await pool.query(query, params);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(rows));
        } catch (error) {
            console.error(error);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Erro ao buscar dados no banco.' }));
        }
    } 
    // API POST: Cadastrar nova tarefa com verificação de conflitos
    else if (pathname === '/api/tasks' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { date, description, startTime, durationMinutes, firstName, taskType } = JSON.parse(body);

                if (!date || !description || !startTime || !durationMinutes || !firstName) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ success: false, message: 'Campos obrigatórios ausentes.' }));
                }

                const startMinutes = timeToMinutes(startTime);
                const endMinutes = startMinutes + parseInt(durationMinutes);
                const startTimeDb = `${startTime}:00`;
                const endTimeDb = minutesToTime(endMinutes);

                // Validação de colisão de horários no mesmo dia
                const [conflicts] = await pool.query(`
                    SELECT task_type, first_name, TIME_FORMAT(start_time, "%H:%i") as start, TIME_FORMAT(end_time, "%H:%i") as end 
                    FROM tasks 
                    WHERE date = ? AND ? < end_time AND ? > start_time
                `, [date, startTimeDb, endTimeDb]);

                if (conflicts.length > 0) {
                    const conflict = conflicts[0];
                    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ 
                        success: false, 
                        message: `Choque de horário com: ${conflict.task_type} ${conflict.first_name} (${conflict.start} às ${conflict.end})` 
                    }));
                }

                const [result] = await pool.query(`
                    INSERT INTO tasks (date, task_type, first_name, description, start_time, duration_minutes, end_time) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [date, taskType || 'Oitiva', firstName, description, startTimeDb, durationMinutes, endTimeDb]);

                res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ 
                    success: true, 
                    task: { id: result.insertId, date, taskType: taskType || 'Oitiva', firstName, description, startTime, durationMinutes: parseInt(durationMinutes), endTime: endTimeDb.substring(0, 5) }
                }));
            } catch (error) {
                console.error(error);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: 'Erro interno ao salvar.' }));
            }
        });
    }
    // API PUT: Editar tarefa existente com verificação de conflitos ignorando a própria tarefa
    else if (pathname === '/api/tasks' && method === 'PUT') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { id, date, description, startTime, durationMinutes, firstName, taskType } = JSON.parse(body);

                if (!id || !date || !description || !startTime || !durationMinutes || !firstName) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ success: false, message: 'Dados incompletos para edição.' }));
                }

                const startMinutes = timeToMinutes(startTime);
                const endMinutes = startMinutes + parseInt(durationMinutes);
                const startTimeDb = `${startTime}:00`;
                const endTimeDb = minutesToTime(endMinutes);

                const [conflicts] = await pool.query(`
                    SELECT task_type, first_name, TIME_FORMAT(start_time, "%H:%i") as start, TIME_FORMAT(end_time, "%H:%i") as end 
                    FROM tasks 
                    WHERE date = ? AND ? < end_time AND ? > start_time AND id != ?
                `, [date, startTimeDb, endTimeDb, id]);

                if (conflicts.length > 0) {
                    const conflict = conflicts[0];
                    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ 
                        success: false, 
                        message: `Choque de horário com: ${conflict.task_type} ${conflict.first_name} (${conflict.start} às ${conflict.end})` 
                    }));
                }

                await pool.query(`
                    UPDATE tasks 
                    SET date = ?, task_type = ?, first_name = ?, description = ?, start_time = ?, duration_minutes = ?, end_time = ?
                    WHERE id = ?
                `, [date, taskType || 'Oitiva', firstName, description, startTimeDb, durationMinutes, endTimeDb, id]);

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ 
                    success: true, 
                    task: { id, date, taskType: taskType || 'Oitiva', firstName, description, startTime, durationMinutes: parseInt(durationMinutes), endTime: endTimeDb.substring(0, 5) }
                }));
            } catch (error) {
                console.error(error);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: 'Erro interno ao atualizar.' }));
            }
        });
    }
    // API DELETE: Remover uma tarefa por ID
    else if (pathname === '/api/tasks' && method === 'DELETE') {
        try {
            const id = parsedUrl.searchParams.get('id');
            if (!id) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({ success: false, message: 'ID não informado.' }));
            }

            await pool.query('DELETE FROM tasks WHERE id = ?', [id]);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true }));
        } catch (error) {
            console.error(error);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Erro ao deletar do banco.' }));
        }
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Não Encontrado');
    }
});

server.listen(PORT, () => {
    console.log(`Servidor ativo na porta ${PORT}`);
});
