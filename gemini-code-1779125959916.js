const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;

// Configuração do Pool de Conexões do MySQL (Dados vindos do DomCloud)
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agenda_db',
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
    // Rota: Página Inicial
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
    } 
    // Rota: Estilos CSS
    else if (req.url === '/style.css' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'style.css'), (err, content) => {
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(content);
        });
    } 
    // API GET: Buscar tarefas do banco de dados
    else if (req.url === '/api/tasks' && req.method === 'GET') {
        try {
            // Buscamos formatando a data e hora direto no SQL para evitar fuso horário do Node
            const [rows] = await pool.query(`
                SELECT 
                    id, 
                    DATE_FORMAT(date, "%Y-%m-%d") as date, 
                    description, 
                    TIME_FORMAT(start_time, "%H:%i") as startTime, 
                    duration_minutes as durationMinutes, 
                    TIME_FORMAT(end_time, "%H:%i") as endTime 
                FROM tasks
            `);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rows));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Erro ao buscar dados do MySQL.' }));
        }
    } 
    // API POST: Validar choque direto no SQL e salvar tarefa
    else if (req.url === '/api/tasks' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { date, description, startTime, durationMinutes } = JSON.parse(body);

                if (!date || !description || !startTime || !durationMinutes) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Preencha todos os campos!' }));
                }

                // Cálculos de Horários
                const startMinutes = timeToMinutes(startTime);
                const endMinutes = startMinutes + parseInt(durationMinutes);
                
                const startTimeDb = `${startTime}:00`;
                const endTimeDb = minutesToTime(endMinutes);

                // Lógica de choque otimizada direto na Query SQL
                const [conflicts] = await pool.query(`
                    SELECT description, TIME_FORMAT(start_time, "%H:%i") as start, TIME_FORMAT(end_time, "%H:%i") as end 
                    FROM tasks 
                    WHERE date = ? AND ? < end_time AND ? > start_time
                `, [date, startTimeDb, endTimeDb]);

                if (conflicts.length > 0) {
                    const conflict = conflicts[0];
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ 
                        success: false, 
                        message: `Choque de horário com a tarefa "${conflict.description}" (${conflict.start} às ${conflict.end})` 
                    }));
                }

                // Inserção no banco de dados se não houver choque
                const [result] = await pool.query(`
                    INSERT INTO tasks (date, description, start_time, duration_minutes, end_time) 
                    VALUES (?, ?, ?, ?, ?)
                `, [date, description, startTimeDb, durationMinutes, endTimeDb]);

                const newTask = {
                    id: result.insertId,
                    date,
                    description,
                    startTime,
                    durationMinutes: parseInt(durationMinutes),
                    endTime: endTimeDb.substring(0, 5)
                };

                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, task: newTask }));

            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Erro interno no servidor MySQL.' }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Não Encontrado');
    }
});

server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});