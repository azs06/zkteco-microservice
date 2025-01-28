const net = require('net');
const fs = require('fs');

// Create a TCP server
const server = net.createServer((socket) => {
  console.log('Device connected:', socket.remoteAddress);

  socket.on('data', (data) => {
    // Parse the raw data (example: ZKTeco's protocol may use hex/binary)
    console.log("Data recieved");
    console.log({ data: data.toString() });
  });

  socket.on('end', () => {
    console.log('Device disconnected');
  });
});

server.listen(8081, '0.0.0.0', () => {
  console.log('TCP server listening on port 8081');
});