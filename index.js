const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const zlib = require('zlib');
const child_process = require('child_process');

const express = require('express');
const tmp = require('tmp');
const tarFs = require('tar-fs');
const httpProxy = require('http-proxy');
const yarnPath = require.resolve('yarn/bin/yarn.js');
const Docker = require('dockerode');

const port = process.env['PORT'] || 80;
const HOSTNAME = 'registry.webmr.io';
const HOSTNAME_REGEX = /^(.+?)\.(.+?)\.webmr\.io$/;
const IMAGE = 'modulesio/webmr-docker';

const docker = new Docker({
  socketPath: '/var/run/docker.sock',
});
const bindings = {};

const app = express();
app.get('/p', (req, res, next) => {
  if (req.hostname === HOSTNAME) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Credentials', 'true');

    res.json(Object.keys(bindings).map(k => bindings[k]));
  } else {
    next();
  }
});
app.put('/p/:username/:module', (req, res, next) => {
  if (req.hostname === HOSTNAME) {
    const {username, module} = req.params;

    if (/^[a-z0-9]+$/i.test(username) && /^[a-z0-9\-]+$/i.test(module)) {
      tmp.dir((err, p, cleanup) => {
        const ws = tarFs.extract(p);
        req.pipe(zlib.createGunzip()).pipe(ws);

        ws.on('finish', () => {
          const packageJsonPath = path.join(p, 'package.json');

          fs.readFile(packageJsonPath, (err, s) => {
            if (!err) {
              const packageJson = JSON.parse(s);
              const {description = null} = packageJson;
              const version = '0.0.1'; // XXX support multiple versions

              const yarnProcess = child_process.spawn(
                process.argv[0],
                [
                  yarnPath,
                  'install',
                  '--production',
                  '--mutex', 'file:' + path.join(os.tmpdir(), '.intrakit-yarn-lock'),
                ],
                {
                  cwd: p,
                  env: process.env,
                }
              );
              yarnProcess.stdout.pipe(process.stdout);
              yarnProcess.stderr.pipe(process.stderr);
              yarnProcess.on('exit', async code => {
                console.log('yarn exit code', code);
                if (code === 0) {
                  let err;
                  try {
                    const container = await docker.createContainer({
                      Image: IMAGE,
                      Tty: false,
                      OpenStdin: false,
                      StdinOnce: false,
                      ExposedPorts: {
                        '80/tcp': {}
                      },
                      HostConfig: {
                        Binds: [
                          `${p}:/root/app`,
                        ],
                        PortBindings: {
                          '80/tcp': [{
                            HostPort: '',
                          }],
                        },
                      },
                      Env: [
                        'PORT=80',
                      ],
                    });
                    await new Promise((accept, reject) => {
                      container.start(err => {
                        if (!err) {
                          accept();
                        } else {
                          reject(err);
                        }
                      });
                    });
                    await new Promise((accept, reject) => {
                      container.inspect((err, data) => {
                        if (!err) {
                          bindings[`${username}/${module}`] = {
                            username,
                            module,
                            description,
                            version,
                            installDirectory: p,
                            port: parseInt(data.NetworkSettings.Ports['80/tcp'][0].HostPort, 10),
                          };

                          accept();
                        } else {
                          reject(err);
                        }
                      });
                    });
                  } catch(e) {
                    err = e;
                  }

                  if (!err) {
                    res.json({
                      username,
                      module,
                      description,
                      version,
                    });
                  } else {
                    res.status(500);
                    res.end(err.stack);
                    cleanup();
                  }
                } else {
                  res.status(500);
                  res.end(new Error('npm publish exited with status code ' + code).stack);
                  cleanup();
                }
              });
            } else if (err.code === 'ENOENT') {
              res.status(400);
              res.end(http.STATUS_CODES[400]);
              cleanup();
            } else {
              res.status(500);
              res.end(err.stack);
              cleanup();
            }
          });
        });
        req.on('error', err => {
          res.status(500);
          res.end(err.stack);
          cleanup();
        });
      }, {
        keep: true,
        unsafeCleanup: true,
      });
    } else {
      res.status(400);
      res.end(http.STATUS_CODES[400]);
    }
  } else {
    next();
  }
});
app.get('*', (req, res, next) => {
  const match = req.hostname.match(HOSTNAME_REGEX);
  if (match) {
    const module = match[1];
    const username = match[2];
    const binding = bindings[`${username}/${module}`];

    if (binding) {
      let {path: p} = req;
      console.log('got path', p);
      if (p === '/') {
        p = '/index.html';
      }
      const rs = fs.createReadStream(path.join(binding.installDirectory, p));
      rs.pipe(res);
      rs.on('error', err => {
        if (err.code === 'ENOENT') {
          const {port} = binding;

          const proxy = httpProxy.createProxyServer();
          proxy.web(req, res, {
            target: `http://127.0.0.1:${port}`,
          });
          proxy.on('error', err => {
            res.status(404);
            res.end(http.STATUS_CODES[404]);
          });
        } else {
          res.status(500);
          res.end(err.stack);
        }
      });
    } else {
      next();
    }
  } else {
    next();
  }
});
http.createServer(app)
  .listen(port);
