CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    date DATE NOT NULL,
    description VARCHAR(255) NOT NULL,
    start_time TIME NOT NULL,
    duration_minutes INT NOT NULL,
    end_time TIME NOT NULL
);