const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const zlib = require('zlib');
const child_process = require('child_process');

const express = require('express');
const tmp = require('tmp');
const bodyParser = require('body-parser');
const bodyParserJson = bodyParser.json();
const phash = require('password-hash-and-salt');
const tarFs = require('tar-fs');
const promiseConcurrency = require('promise-concurrency');
const yarnPath = require.resolve('yarn/bin/yarn.js');
const rollup = require('rollup');
const rollupPluginNodeResolve = require('rollup-plugin-node-resolve');
const rollupPluginCommonJs = require('rollup-plugin-commonjs');
const rollupPluginJson = require('rollup-plugin-json');
const ignore = require('ignore');
const {meaningful} = require('meaningful-string');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const PORT = process.env['PORT'] || 8000;
const BUCKET = 'files.webmr.io';

const _requestUserFromCredentials = (email, password) => new Promise((accept, reject) => {
  s3.getObject({
    Bucket: BUCKET,
    Key: path.join('_users', email),
  }, (err, result) => {
    if (!err) {
      const hash = result.Body.toString('utf8');

      phash(password).verifyAgainst(hash, (err, verified) => {
        if (!err) {
          if (verified) {
            accept({
              email,
            });
          } else {
            const err = new Error('invalid password');
            err.code = 'EAUTH';
            reject(err);
          }
        } else {
          reject(err);
        }
      });
    } else {
      reject(err);
    }
  });
});

const app = express();
app.get('/', (req, res, next) => {
  res.end('Hello, webmr registry!\n');
});
app.post('/l', bodyParserJson, (req, res, next) => {
  if (req.body && typeof req.body.email === 'string' && typeof req.body.password === 'string') {
    s3.getObject({
      Bucket: BUCKET,
      Key: path.join('_users', req.body.email),
    }, (err, result) => {
      if (!err) {
        const hash = result.Body.toString('utf8');

        phash(req.body.password).verifyAgainst(hash, (err, verified) => {
          if (!err) {
            if (verified) {
              res.json({});
            } else {
              res.status(403);
              res.end(http.STATUS_CODES[403]);
            }
          } else {
            res.status(500);
            res.end(err.stack);
          }
        });
      } else if (err.code === 'NoSuchKey') {
        phash(req.body.password).hash((err, hash) => {
          if (!err) {
            console.log('put hash', {password: req.body.password, hash});

            s3.putObject({
              Bucket: BUCKET,
              Key: path.join('_users', req.body.email),
              Body: hash,
            }, err => {
              if (!err) {
                res.json({});
              } else {
                res.status(500);
                res.end(err.stack);
              }
            });
          } else {
            res.status(500);
            res.end(err.stack);
          }
        });
      } else {
        res.status(500);
        res.end(err.stack);
      }
    });
    rs.on('error', err => {
      if (err.code === 'NoSuchKey') {
        phash(req.body.password).hash((err, hash) => {
          if (!err) {
            console.log('got hash', hash);
          } else {
            res.status(500);
            res.end(err.stack);
          }
        });
      } else {
        res.status(500);
        res.end(err.stack);
      }
    });
  } else {
    res.status(400);
    res.end(http.STATUS_CODES[400]);
  }
});
app.get('/p', (req, res, next) => {
  _cors(req, res);

  s3.listObjects({
    Bucket: BUCKET,
  }, (err, data) => {
    if (!err) {
      res.json(data.Contents.map(({Key}) => Key));
    } else {
      res.status(500);
      res.end(err.stack);
    }
  });
});
app.get('/p/:project*', (req, res, next) => {
  _cors(req, res);

  const {project} = req.params;
  const p = req.params[0];

  s3.listObjects({
    Bucket: BUCKET,
    Prefix: path.join(project, p),
  }, (err, data) => {
    if (!err) {
      res.json(data.Contents.map(({Key}) => Key));
    } else {
      res.status(500);
      res.end(err.stack);
    }
  });
});
const _readFile = (p, opts) => new Promise((accept, reject) => {
  fs.readFile(p, opts, (err, data) => {
    if (!err) {
      accept(data);
    } else if (err.code === 'ENOENT') {
      accept(null);
    } else {
      reject(err);
    }
  });
});
const _getIgnore = (p, main, browser) => Promise.all([
  _readFile(path.join(p, '.gitignore'), 'utf8'),
  _readFile(path.join(p, '.npmignore'), 'utf8'),
])
  .then(([
    gitignore,
    npmignore,
  ]) => {
    const ig = ignore();

    const contents = npmignore || gitignore || null;
    if (contents) {
      ig.add(contents.split('\n'));
    }
    if (main) {
      ig.add(main);
    }
    if (typeof browser === 'object') {
      for (const k in browser) {
        ig.add(k);
      }
    }

    return Promise.resolve(ig);
  });
const _uploadModule = (p, basePath, ig, prefix) => {
  const _uploadFile = p => new Promise((accept, reject) => {
    if (!ig.ignores(p) && !/^\/\.git\//.test(p)) {
      const fullPath = path.join(basePath, p);

      s3.upload({
        Bucket: BUCKET,
        Key: path.join(prefix, p),
        Body: fs.createReadStream(fullPath),
      }, err => {
        if (!err) {
          accept();
        } else {
          reject(err);
        }
      });
    } else {
      accept();
    }
  });

  const promiseFactories = [];
  const _recurse = p => new Promise((accept, reject) => {
    const fullPath = path.join(basePath, p);

    fs.readdir(fullPath, async (err, files) => {
      if (!err) {
        if (files.length > 0) {
          try {
            for (const fileName of files) {
              const p2 = path.join(p, fileName);
              const fullPath2 = path.join(basePath, p2);

              await new Promise((accept, reject) => {
                fs.lstat(fullPath2, (err, stats) => {
                  if (!err) {
                    if (stats.isDirectory()) {
                      _recurse(p2)
                        .then(accept, reject);
                    } else if (stats.isFile()) {
                      promiseFactories.push(_uploadFile.bind(null, p2));

                      accept();
                    } else {
                      accept();
                    }
                  } else {
                    reject(err);
                  }
                });
              });
            }

            accept();
          } catch(err) {
            reject(err);
          }
        } else {
          accept();
        }
      } else {
        reject(err);
      }
    });
  });
  return _recurse(p)
    .then(() => {
      console.log(`uploading ${promiseFactories.length} files`);
      return promiseConcurrency(promiseFactories, 8);
    });
};
app.put('/p', (req, res, next) => {
  tmp.dir((err, p, cleanup) => {
    const us = req.pipe(zlib.createGunzip());
    us.on('error', err => {
      res.status(500);
      res.end(err.stack);
      cleanup();
    });
    const ws = us.pipe(tarFs.extract(p));

    ws.on('finish', () => {
      const packageJsonPath = path.join(p, 'package.json');

      fs.readFile(packageJsonPath, (err, s) => {
        if (!err) {
          const packageJson = JSON.parse(s);
          const {name, version = '0.0.1', description = null, main, browser} = packageJson;

          console.log('install module', {name, version});

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
            if (code === 0) {
              const _bundleAndUploadFile = fileSpec => rollup.rollup({
                input: path.join(p, fileSpec[1]),
                plugins: [
                  rollupPluginNodeResolve({
                    main: true,
                    preferBuiltins: false,
                  }),
                  rollupPluginCommonJs(),
                  rollupPluginJson(),
                ],
                /* output: {
                  name,
                }, */
              })
                .then(bundle => Promise.all([
                  bundle.generate({
                    name: module,
                    format: 'es',
                    strict: false,
                  }).then(result => result.code),
                  bundle.generate({
                    name: module,
                    format: 'cjs',
                    strict: false,
                  }).then(result => result.code),
                ]))
                .catch(err => {
                  console.warn('build error', err.stack);
                  return Promise.resolve([null, null]);
                })
                .then(([codeEs, codeCjs]) => {
                  const fileName = fileSpec[0].replace(/\.[^\/]+$/, '');

                  return Promise.all([
                    new Promise((accept, reject) => {
                      s3.putObject({
                        Bucket: BUCKET,
                        Key: path.join(name, version, `${fileName}.mjs`),
                        Body: codeEs,
                      }, err => {
                        if (!err) {
                          accept();
                        } else {
                          reject(err);
                        }
                      });
                    }),
                    new Promise((accept, reject) => {
                      s3.putObject({
                        Bucket: BUCKET,
                        Key: path.join(name, version, `${fileName}.js`),
                        Body: codeCjs,
                      }, err => {
                        if (!err) {
                          accept();
                        } else {
                          reject(err);
                        }
                      });
                    }),
                  ])
                })
                .then(() => {});

              const bundleFiles = (main ? [[main, main]] : [])
                .concat(typeof browser === 'object' ?
                    Object.keys(browser).map(k => {
                      const v = browser[k];
                      if (v) {
                        if (typeof v === 'string') {
                          return [k, v];
                        } else {
                          return [k, k];
                        }
                      } else {
                        return null;
                      }
                    }).filter(browserFile => browserFile !== null)
                  :
                    []
                );

              await Promise.all(
                [(async () => {
                  const ig = await _getIgnore(p, main, browser);
                  await _uploadModule('/', p, ig, `${name}/${version}`);
                })()]
                  .concat(bundleFiles.map(fileSpec => _bundleAndUploadFile(fileSpec)))
              )
                .then(() => {
                  res.json({
                    name,
                    version,
                    description,
                    files: bundleFiles.map(fileSpec => fileSpec[0]),
                  });
                  cleanup();
                })
                .catch(err => {
                  res.status(500);
                  res.end(err.stack);
                  cleanup();
                });
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
});
/* app.get('*', (req, res, next) => {
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
}); */
app.get('/f*', (req, res, next) => {
  const p = req.params[0];
  let extname = path.extname(p);
  if (extname) {
    extname = extname.slice(1);
  } else {
    extname = 'application/octet-stream';
  }

  const params = {
    Bucket: BUCKET,
    Key: path.join(project, version, p),
  };
  if (req.headers['if-none-match']) {
    params.IfNoneMatch = req.headers['if-none-match'];
  }
  if (req.headers['range']) {
    params.IfNoneMatch = req.headers['range'];
  }
  const objectStream = s3.getObject(params);
  let etag;
  objectStream.on('httpHeaders', (statusCode, headers, response, statusMessage) => {
    res.status(statusCode);
    res.set(headers);
  });
  const rs = objectStream.createReadStream();
  res.type(extname);
  rs.pipe(res);
  rs.on('error', err => {
    if (err.code === 'NoSuchKey') {
      res.status(404);
      res.end(http.STATUS_CODES[404]);
    } else {
      res.status(500);
      res.end(err.stack);
    }
  });
});
app.put('/f*', (req, res, next) => {
  const authorization = req.get('authorization') || '';
  const basic = authorization.match(/^Basic\s+(.+)$/i)[1];
  if (basic) {
    const [email, password] = Buffer.from(basic, 'base64').toString('utf8').split(':');

    _requestUserFromCredentials(email, password)
      .then(() => {
        const p = req.params[0];
        const key = path.join('_files', meaningful().toLowerCase(), p);

        s3.upload({
          Bucket: BUCKET,
          Key: key,
          Body: req,
        }, (err, data) => {
          if (!err) {
            res.json({
              path: key,
            });
          } else {
            res.status(500);
            res.end(err.stack);
          }
        });
      })
      .catch(err => {
        if (err.code === 'EAUTH') {
          res.status(403);
          res.end(http.STATUS_CODES[403]);
        } else {
          res.status(500);
          res.end(err.stack);
        }
      });
  } else {
    res.status(401);
    res.end(http.STATUS_CODES[401]);
  }
});
app.get('/:project/:version*', (req, res, next) => {
  const {project, version} = req.params;
  const p = req.params[0] || 'index.html';
  let extname = path.extname(p);
  if (extname) {
    extname = extname.slice(1);
  } else {
    extname = 'application/octet-stream';
  }

  const params = {
    Bucket: BUCKET,
    Key: path.join(project, version, p),
  };
  if (req.headers['if-none-match']) {
    params.IfNoneMatch = req.headers['if-none-match'];
  }
  if (req.headers['range']) {
    params.IfNoneMatch = req.headers['range'];
  }
  const objectStream = s3.getObject(params);
  let etag;
  objectStream.on('httpHeaders', (statusCode, headers, response, statusMessage) => {
    res.status(statusCode);
    res.set(headers);
  });
  const rs = objectStream.createReadStream();
  res.type(extname);
  rs.pipe(res);
  rs.on('error', err => {
    if (err.code === 'NoSuchKey') {
      res.status(404);
      res.end(http.STATUS_CODES[404]);
    } else {
      res.status(500);
      res.end(err.stack);
    }
  });
});
const _cors = (req, res) => {
  res.set('Access-Control-Allow-Origin', '**');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Credentials', 'true');
};
http.createServer(app)
  .listen(PORT);

process.on('uncaughtException', err => {
  console.warn(err);
});
/* global.s3 = s3;
require('repl').start(); */
