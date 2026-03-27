// ABOUTME: TCP echo server for testing bidirectional communication with the DO.
// ABOUTME: Listens on port 9000, echoes back received data prefixed with "echo: ".

import { createServer } from 'net';

const PORT = 9000;

const server = createServer((socket) => {
  console.log('Client connected');

  socket.on('data', (data) => {
    const message = data.toString();
    console.log(`Received: ${message}`);
    socket.write(`echo: ${message}`);
  });

  socket.on('end', () => {
    console.log('Client disconnected');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Echo server listening on port ${PORT}`);
});
