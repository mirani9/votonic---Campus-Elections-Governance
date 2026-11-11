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
  globalStatus: "OPEN", // Master state synchronized across all portals
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
    console.log("Initializing fresh JSON store...");
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

// Global Poll Status (Syncs ALL Portals)
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
  res.json({ globalStatus: db.globalStatus, elections: db.elections });
});

app.post('/api/elections/status', (req, res) => {
  const { election_id, status } = req.body;
  const el = db.elections.find(e => e.id === election_id);
  if (el) {
    el.status = status;
    saveDB();
    broadcastEvent('poll_state_changed', { election_id, status });
  }
  res.json({ status: "SUCCESS" });
});

app.get('/api/candidates', (req, res) => {
  const { election_id } = req.query;
  let list = db.candidates;
  if (election_id) {
    list = list.filter(c => c.election_id === election_id);
  }
  res.json(list);
});

app.post('/api/candidates/review', (req, res) => {
  const { candidate_id, status } = req.body;
  const candidate = db.candidates.find(c => c.id === candidate_id);
  if (candidate) {
    candidate.status = status;
    saveDB();
    broadcastEvent('nomination_reviewed', { candidate_id, status });
  }
  res.json({ status: "SUCCESS" });
});

app.post('/api/vote', (req, res) => {
  const { voter_id, candidate_id, election_id } = req.body;

  // Enforce global or specific election closure check across all portals
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
    return res.status(429).json({ error: "Duplicate vote rejected. Voter has already participated." });
  }

  const candidate = db.candidates.find(c => c.id === candidate_id && c.status === 'ACCEPTED');
  if (!candidate) {
    return res.status(404).json({ error: "Invalid or unapproved candidate." });
  }

  db.votes.push({ voter_id, candidate_id, election_id, created_at: new Date().toISOString() });
  candidate.votes++;
  saveDB();

  broadcastEvent('vote_persisted', { voter_id, candidate_id, election_id });
  res.json({ status: "SUCCESS", voter_id, candidate_id });
});

app.get('/api/stats', (req, res) => {
  res.json({
    persisted_votes: db.votes.length,
    rate_limited_requests: 0,
    queue_depth: 0,
    pending_votes: 0,
    failed_votes: 0
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
  console.log(`[VOTONIC Engine] Synchronized at http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});