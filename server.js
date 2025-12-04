const http = require('http');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, calls: activeCalls.size / 2 }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Klik Call Server');
});

const wss = new WebSocket.Server({ server });

const clients = new Map();
const activeCalls = new Map();

wss.on('connection', (ws, req) => {
  let userId = null;
  
  console.log('New connection from:', req.socket.remoteAddress);
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  ws.on('message', (data) => {
    try {
      if (data instanceof Buffer && data.length > 100) {
        handleMediaData(ws, userId, data);
        return;
      }
      
      const message = JSON.parse(data.toString());
      console.log('Message:', message.type, 'from:', userId || message.userId);
      
      switch (message.type) {
        case 'register':
          userId = message.userId;
          clients.set(userId, ws);
          ws.userId = userId;
          console.log(`User registered: ${userId}, total clients: ${clients.size}`);
          ws.send(JSON.stringify({ type: 'registered', userId }));
          break;
          
        case 'call-request':
          const targetOnline = clients.has(message.to);
          if (targetOnline) {
            forwardToUser(message.to, {
              type: 'call-request',
              from: userId,
              callType: message.callType,
              fromName: message.fromName,
              fromPhoto: message.fromPhoto
            });
          } else {
            ws.send(JSON.stringify({
              type: 'user-offline',
              userId: message.to
            }));
          }
          break;
          
        case 'call-accept':
          activeCalls.set(userId, message.from);
          activeCalls.set(message.from, userId);
          forwardToUser(message.from, {
            type: 'call-accepted',
            from: userId
          });
          console.log(`Call established: ${userId} <-> ${message.from}`);
          break;
          
        case 'call-decline':
          forwardToUser(message.from, {
            type: 'call-declined',
            from: userId,
            reason: message.reason || 'declined'
          });
          break;
          
        case 'call-end':
          const partnerId = activeCalls.get(userId);
          if (partnerId) {
            forwardToUser(partnerId, {
              type: 'call-ended',
              from: userId,
              reason: message.reason
            });
            activeCalls.delete(userId);
            activeCalls.delete(partnerId);
            console.log(`Call ended: ${userId} <-> ${partnerId}`);
          }
          break;
          
        case 'media-chunk':
          const callPartner = activeCalls.get(userId);
          if (callPartner) {
            const partnerWs = clients.get(callPartner);
            if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
              partnerWs.send(JSON.stringify({
                type: 'media-chunk',
                from: userId,
                mediaType: message.mediaType,
                data: message.data,
                timestamp: message.timestamp
              }));
            }
          }
          break;
          
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  ws.on('close', () => {
    if (userId) {
      console.log(`User disconnected: ${userId}`);
      clients.delete(userId);
      
      const partnerId = activeCalls.get(userId);
      if (partnerId) {
        forwardToUser(partnerId, {
          type: 'call-ended',
          from: userId,
          reason: 'disconnected'
        });
        activeCalls.delete(userId);
        activeCalls.delete(partnerId);
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

function handleMediaData(ws, userId, data) {
  const partnerId = activeCalls.get(userId);
  if (partnerId) {
    const partnerWs = clients.get(partnerId);
    if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
      partnerWs.send(data);
    }
  }
}

function forwardToUser(targetUserId, message) {
  const targetWs = clients.get(targetUserId);
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify(message));
    return true;
  }
  return false;
}

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating inactive connection:', ws.userId);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Klik Call Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});
