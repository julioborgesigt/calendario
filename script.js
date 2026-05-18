require('dotenv').config();
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json());
// Serve os arquivos estáticos (index.html, style.css) diretamente da pasta atual
app.use(express.static(path.join(__dirname))); 

// Configuração do Pool de Conexões do MySQL com timezone fixado
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '-03:00'
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

// API GET: Buscar tarefas filtradas por mês/ano ou intervalo de datas
app.get('/api/tasks', async (req, res) => {
    try {
        const { month, year, startDate, endDate } = req.query;
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

        if (startDate && endDate) {
            query += " WHERE date >= ? AND date <= ?";
            params.push(startDate, endDate);
        } else if (month && year) {
            query += " WHERE MONTH(date) = ? AND YEAR(date) = ?";
            params.push(month, year);
        }

        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao buscar dados no banco.' });
    }
});

// API POST: Cadastrar nova tarefa com verificação de conflitos
app.post('/api/tasks', async (req, res) => {
    try {
        const { date, description, startTime, durationMinutes, firstName, taskType } = req.body;

        if (!date || !description || !startTime || !durationMinutes || !firstName) {
            return res.status(400).json({ success: false, message: 'Campos obrigatórios ausentes.' });
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
            return res.status(409).json({ 
                success: false, 
                message: `Choque de horário com: ${conflict.task_type} ${conflict.first_name} (${conflict.start} às ${conflict.end})` 
            });
        }

        const [result] = await pool.query(`
            INSERT INTO tasks (date, task_type, first_name, description, start_time, duration_minutes, end_time) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [date, taskType || 'Oitiva', firstName, description, startTimeDb, durationMinutes, endTimeDb]);

        res.status(201).json({ 
            success: true, 
            task: { id: result.insertId, date, taskType: taskType || 'Oitiva', firstName, description, startTime, durationMinutes: parseInt(durationMinutes), endTime: endTimeDb.substring(0, 5) }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro interno ao salvar.' });
    }
});

// API PUT: Editar tarefa existente com verificação de conflitos ignorando a própria tarefa
app.put('/api/tasks', async (req, res) => {
    try {
        const { id, date, description, startTime, durationMinutes, firstName, taskType } = req.body;

        if (!id || !date || !description || !startTime || !durationMinutes || !firstName) {
            return res.status(400).json({ success: false, message: 'Dados incompletos para edição.' });
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
            return res.status(409).json({ 
                success: false, 
                message: `Choque de horário com: ${conflict.task_type} ${conflict.first_name} (${conflict.start} às ${conflict.end})` 
            });
        }

        await pool.query(`
            UPDATE tasks 
            SET date = ?, task_type = ?, first_name = ?, description = ?, start_time = ?, duration_minutes = ?, end_time = ?
            WHERE id = ?
        `, [date, taskType || 'Oitiva', firstName, description, startTimeDb, durationMinutes, endTimeDb, id]);

        res.json({ 
            success: true, 
            task: { id, date, taskType: taskType || 'Oitiva', firstName, description, startTime, durationMinutes: parseInt(durationMinutes), endTime: endTimeDb.substring(0, 5) }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar.' });
    }
});

// API DELETE: Remover uma tarefa por ID
app.delete('/api/tasks', async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ success: false, message: 'ID não informado.' });
        }

        await pool.query('DELETE FROM tasks WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao deletar do banco.' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor Express ativo na porta ${PORT}`);
});
