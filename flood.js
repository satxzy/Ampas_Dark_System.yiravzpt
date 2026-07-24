// fast.js
// Versi cepat: bikin banyak repo langsung, upload file paralel, retry 409.
// Pakai: node fast.js --token <ghp_xxx> --name <nama> --count <jumlah>

const https = require('https');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let token = '';
let baseName = 'repo';
let count = 1;
let concurrency = 10; // bisa disesuaikan

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--token' && args[i+1]) token = args[++i];
  else if (args[i] === '--name' && args[i+1]) baseName = args[++i];
  else if (args[i] === '--count' && args[i+1]) count = parseInt(args[++i], 10) || 1;
}

if (!token || count < 1) {
  console.log('Usage: node fast.js --token <ghp_xxx> --name <reponame> --count <jumlah>');
  process.exit(1);
}

// GitHub API dengan retry (untuk 409 conflict)
function github(method, apiPath, body = null, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': 'fast-uploader',
          'Content-Type': 'application/json',
        },
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(data); }
          } else if ((res.statusCode === 409 || res.statusCode >= 500) && n > 1) {
            setTimeout(() => attempt(n - 1), 500 * (4 - n)); // backoff
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', e => {
        if (n > 1) setTimeout(() => attempt(n - 1), 1000);
        else reject(e);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    };
    attempt(retries);
  });
}

// Baca semua file rekursif (skip .git, node_modules, file ini)
function getAllFiles(dir, ignorePaths) {
  const ignore = new Set(ignorePaths);
  const results = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (ignore.has(full)) continue;
    if (item.isDirectory()) {
      if (item.name === '.git' || item.name === 'node_modules') continue;
      results.push(...getAllFiles(full, ignorePaths));
    } else {
      results.push(full);
    }
  }
  return results;
}

function randomSuffix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789.-~';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return '.' + s;
}

// Upload semua file paralel ke satu repo
async function uploadFiles(owner, repo, branch, files, baseDir) {
  const tasks = files.map(async (absPath) => {
    const rel = path.relative(baseDir, absPath).replace(/\\/g, '/');
    const content = await fs.promises.readFile(absPath);
    const b64 = content.toString('base64');
    return github('PUT', `/repos/${owner}/${repo}/contents/${rel}`, {
      message: `Add ${rel}`,
      content: b64,
      branch: branch,
    });
  });
  await Promise.all(tasks);
}

// Buat 1 repo lalu upload
async function createRepo(owner, files, baseDir) {
  let repoName = baseName + randomSuffix();
  let repo;
  try {
    repo = await github('POST', '/user/repos', {
      name: repoName,
      private: false,
      auto_init: true,
    });
  } catch (e) {
    if (e.message.includes('422')) {
      repoName = baseName + randomSuffix();
      repo = await github('POST', '/user/repos', {
        name: repoName,
        private: false,
        auto_init: true,
      });
    } else throw e;
  }
  if (files.length > 0) {
    await uploadFiles(owner, repo.name, repo.default_branch, files, baseDir);
  }
  return repo.html_url;
}

(async () => {
  const startTime = Date.now();
  console.log('Login...');
  const user = await github('GET', '/user');
  const owner = user.login;
  console.log(`User: ${owner}`);

  const scriptPath = __filename;
  const files = getAllFiles('.', [scriptPath]);
  console.log(`File: ${files.length} | Repo: ${count}`);

  // Antrian repo (pakai pool concurrency)
  const queue = Array.from({ length: count }, (_, i) => i + 1);
  let done = 0;
  const workers = [];

  const worker = async () => {
    while (queue.length) {
      queue.shift();
      try {
        const url = await createRepo(owner, files, '.');
        done++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${done}/${count}] ${url} (${elapsed}s)`);
      } catch (e) {
        done++;
        console.log(`Gagal: ${e.message}`);
      }
    }
  };

  for (let i = 0; i < Math.min(concurrency, count); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nSelesai: ${done} repo dalam ${totalTime}s`);
})();