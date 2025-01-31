const net = require('net');
const fs = require('fs');

const server = net.createServer((socket) => {
  console.log('Device connected:', socket.remoteAddress);

  // Accumulate data across chunks (in case of fragmented messages)
  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString(); // Append incoming data to buffer

    // Split messages by line (ZKTeco often uses \r\n as a delimiter)
    const messages = buffer.split('\r\n');
    buffer = messages.pop(); // Leave incomplete messages in the buffer

    messages.forEach((message) => {
      if (message.trim() === '') return; // Skip empty lines

      // Parse the message into key-value pairs
      const parsedData = parseZKTecoData(message);
      console.log('Parsed Data:', parsedData);

      // Example: Log to a file/database
      if (parsedData.PIN) {
        fs.appendFileSync('attendance.log', `User ${parsedData.PIN} scanned at ${parsedData.DateTime}\n`);
      }
    });
  });

  socket.on('end', () => {
    console.log('Device disconnected');
  });
});

// Parse ZKTeco's key-value format (e.g., "PIN=5\tDateTime=...")
function parseZKTecoData(rawData) {
  if (rawData.startsWith('GET /iclock/cdata')) {
    // Parse the initial handshake (query parameters)
    const url = new URL(`http://dummy${rawData.split(' ')[1]}`);
    const sn = url.searchParams.get('SN');
    console.log('Device SN:', sn);
    return { type: 'handshake', SN: sn };
  } else if (rawData.includes('=')) {
    // Parse key-value attendance data
    const entries = rawData.split('\t');
    const parsed = {};
    entries.forEach((entry) => {
      const [key, value] = entry.split('=');
      if (key && value) parsed[key] = value;
    });
    return { type: 'attendance', ...parsed };
  } else {
    // Unknown message type (e.g., heartbeat)
    return { type: 'unknown', rawData };
  }
}

server.listen(8081, '0.0.0.0', () => {
  console.log('TCP server listening on port 8081');
});