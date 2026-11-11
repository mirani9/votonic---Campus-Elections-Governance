const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'poll_store.json');

let db = {
  globalStatus: "OPEN",
  users: [
    { id: "ADMIN001", name: "System Admin", role: "ADMIN", password: "admin" },
    { id: "STUDENT001", name: "Alex Mercer", role: "STUDENT", password: "123" }
  ],
  elections: [
    { id: "el-1", title: "Sports Secretary 2027", description: "Lead campus athletics", deadline: "2026-11-20", status: "CLOSED" },
    { id: "el-2", title: "Cultural Club Head", description: "Manage campus festivals", deadline: "2026-12-05", status: "OPEN" },
    { id: "el-3", title: "sports", description: "Annual sports committee", deadline: "2026-11-12", status: "OPEN" },
    { id: "el-4", title: "cult", description: "Cultural council election", deadline: "2026-11-12", status: "OPEN" }
  ],
  candidates: [
    { id: "cand001", election_id: "el-3", name: "Alice Johnson", roll: "CAND001", manifesto: "Better equipment and transparent sports budget.", status: "ACCEPTED", votes: 14 },
    { id: "cand002", election_id: "el-3", name: "Carol Williams", roll: "CAND002", manifesto: "More inter-college tournaments and coaching.", status: "ACCEPTED", votes: 8 },
    { id: "cand003", election_id: "el-4", name: "abc", roll: "cand03", manifesto: "mjvkbf", status: "PENDING", votes: 0 }
  ],
  votes: []
};

if (fs.existsSync(DB_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (loaded) db = Object.assign(db, loaded);
  } catch (e) {
    console.log("Initializing store...");
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let clients = [];
function broadcastEvent(eventType, payload) {
  const data = JSON.stringify({ event: eventType, ...payload, timestamp: new Date().toISOString() });
  clients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

app.get('/api/poll/status', (req, res) => {
  res.json({ status: db.globalStatus, elections: db.elections });
});

app.post('/api/poll/open', (req, res) => {
  const { election_id } = req.body;
  if (election_id) {
    const el = db.elections.find(e => e.id === election_id);
    if (el) el.status = 'OPEN';
  } else {
    db.globalStatus = 'OPEN';
    db.elections.forEach(e => e.status = 'OPEN');
  }
  saveDB();
  broadcastEvent('poll_state_changed', { status: 'OPEN', election_id });
  res.json({ status: "OPEN" });
});

app.post('/api/poll/close', (req, res) => {
  const { election_id } = req.body;
  if (election_id) {
    const el = db.elections.find(e => e.id === election_id);
    if (el) el.status = 'CLOSED';
  } else {
    db.globalStatus = 'CLOSED';
    db.elections.forEach(e => e.status = 'CLOSED');
  }
  saveDB();
  broadcastEvent('poll_state_changed', { status: 'CLOSED', election_id });
  res.json({ status: "CLOSED" });
});

app.get('/api/elections', (req, res) => {
  res.json(db.elections);
});

app.post('/api/elections', (req, res) => {
  const { title, description, deadline } = req.body;
  const newEl = { id: 'el-' + Date.now(), title, description: description || '', deadline: deadline || '2026-11-20', status: 'OPEN' };
  db.elections.push(newEl);
  saveDB();
  broadcastEvent('poll_state_changed', { status: 'OPEN' });
  res.json(newEl);
});

app.get('/api/candidates', (req, res) => {
  const { election_id } = req.query;
  let list = db.candidates;
  if (election_id) list = list.filter(c => c.election_id === election_id);
  res.json(list);
});

app.post('/api/candidates/review', (req, res) => {
  const { candidate_id, status } = req.body;
  const cand = db.candidates.find(c => c.id === candidate_id);
  if (cand) {
    cand.status = status;
    saveDB();
    broadcastEvent('nomination_reviewed', { candidate_id, status });
  }
  res.json({ status: "SUCCESS" });
});

app.post('/api/users', (req, res) => {
  const { roll, password, name, role } = req.body;
  const newUser = { id: roll, name, role: role || 'STUDENT', password: password || '123' };
  db.users.push(newUser);
  saveDB();
  res.json(newUser);
});

app.post('/api/vote', (req, res) => {
  const { voter_id, candidate_id, election_id } = req.body;

  if (db.globalStatus === 'CLOSED') {
    return res.status(403).json({ error: "All campus elections are currently CLOSED by System Admin." });
  }

  if (election_id) {
    const el = db.elections.find(e => e.id === election_id);
    if (!el || el.status !== 'OPEN') {
      return res.status(403).json({ error: "This election is currently CLOSED." });
    }
  }

  const existing = db.votes.find(v => v.voter_id === voter_id && (!election_id || v.election_id === election_id));
  if (existing) {
    return res.status(429).json({ error: "Duplicate vote rejected. You have already voted." });
  }

  const cand = db.candidates.find(c => c.id === candidate_id && c.status === 'ACCEPTED');
  if (!cand) {
    return res.status(404).json({ error: "Invalid or unapproved candidate." });
  }

  db.votes.push({ voter_id, candidate_id, election_id, created_at: new Date().toISOString() });
  cand.votes++;
  saveDB();

  broadcastEvent('vote_persisted', { voter_id, candidate_id, election_id });
  res.json({ status: "SUCCESS", voter_id, candidate_id });
});

app.get('/api/stats', (req, res) => {
  res.json({
    persisted_votes: db.votes.length,
    total_elections: db.elections.length,
    pending_nominations: db.candidates.filter(c => c.status === 'PENDING').length,
    total_users: db.users.length
  });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`[VOTONIC Engine] Synchronized on http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});