const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const child_process = require('child_process');
const util = require('util');
const {promisify} = util;

const express = require('express');
const tmp = require('tmp');
const bodyParser = require('body-parser');
const bodyParserJson = bodyParser.json();
const bodyParserBuffer = bodyParser.raw({
  type: 'application/octet-stream',
});
const mime = require('mime');
const semver = require('semver');
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
const httpProxy = require('http-proxy');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const redis = require('redis');

const PORT = process.env['PORT'] || 9000;
const BUCKET = 'files.webmr.io';
const HOST = 'https://registry.webmr.io';
const FILES_HOST = 'https://files.webmr.io';
const MULTIPLAYER_HOST = 'https://multiplayer.webmr.io';
const CIPHER = 'AES-256-CTR';

const {AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, HASH_KEY, REDIS_URL} = process.env;
if (!AWS_ACCESS_KEY_ID) {
  console.warn('need AWS_ACCESS_KEY_ID');
  process.exit(1);
}
if (!AWS_SECRET_ACCESS_KEY) {
  console.warn('need AWS_SECRET_ACCESS_KEY');
  process.exit(1);
}
if (!HASH_KEY) {
  console.warn('need HASH_KEY');
  process.exit(1);
}
if (!REDIS_URL) {
  console.warn('need REDIS_URL');
  process.exit(1);
}
const secret = crypto.createHmac('sha256', HASH_KEY)
  .update(HASH_KEY)
  .digest();
const rc = redis.createClient(REDIS_URL, {
  return_buffers: true,
});
const rcGetAsync = promisify(rc.get.bind(rc));
const rcSetAsync = promisify(rc.set.bind(rc));

const _encrypt = (d, iv) => new Promise((accept, reject) => {
  const cipher = crypto.createCipheriv(CIPHER, secret, iv);
  cipher.end(d);
  const bs = [];
  cipher.on('data', d => {
    bs.push(d);
  });
  cipher.on('end', () => {
    const b = Buffer.concat(bs);
    accept(b);
  });
});
const _decrypt = (d, iv) => new Promise((accept, reject) => {
  const cipher = crypto.createDecipheriv(CIPHER, secret, iv);
  cipher.end(d);
  const bs = [];
  cipher.on('data', d => {
    bs.push(d);
  });
  cipher.on('end', () => {
    const b = Buffer.concat(bs);
    accept(b);
  });
});
const _requestUserFromUsernameToken = (username, t) => new Promise((accept, reject) => {
  s3.getObject({
    Bucket: BUCKET,
    Key: path.join('_users', username),
  }, (err, result) => {
    if (!err) {
      const j = JSON.parse(result.Body.toString('utf8'));
      const {id, hashEnc, hashIv, tokenEnc, tokenIv} = j;

      Promise.all([
        _decrypt(Buffer.from(hashEnc, 'base64'), Buffer.from(hashIv, 'base64')),
        _decrypt(Buffer.from(tokenEnc, 'base64'), Buffer.from(tokenIv, 'base64')),
      ])
        .then(([
          hash,
          token,
        ]) => {
          hash = hash.toString('utf8');
          token = token.toString('base64');

          if (t === token) {
            accept({
              id,
              username,
              hash,
              token,
            });
          } else {
            const err = new Error('invalid password');
            err.code = 'EAUTH';
            reject(err);
          }
        });
    } else if (err.code === 'NoSuchKey') {
      const err = new Error('no such user');
      err.code = 'EAUTH';
      reject(err);
    } else {
      reject(err);
    }
  });
});
const _getProject = project => new Promise((accept, reject) => {
  s3.getObject({
    Bucket: BUCKET,
    Key: path.join('_projects', project),
  }, (err, result) => {
    if (!err) {
      const j = JSON.parse(result.Body.toString('utf8'));
      accept(j);
    } else if (err.code === 'NoSuchKey') {
      accept(null);
    } else {
      reject(err);
    }
  });
});
const _setProject = (project, projectSpec) => new Promise((accept, reject) => {
  s3.putObject({
    Bucket: BUCKET,
    Key: path.join('_projects', project),
    ContentType: 'application/json',
    Body: JSON.stringify(projectSpec),
  }, err => {
    if (!err) {
      accept();
    } else {
      reject(err);
    }
  });
});

const app = express();
app.all('*', (req, res, next) => {
  _cors(req, res);

  next();
});
app.post('/l', bodyParserJson, (req, res, next) => {
  if (req.body && typeof req.body.username === 'string' && typeof req.body.password === 'string') {
    s3.getObject({
      Bucket: BUCKET,
      Key: path.join('_users', req.body.username),
    }, (err, result) => {
      if (!err) {
        const j = JSON.parse(result.Body.toString('utf8'));
        const {id, username, hashEnc, hashIv, tokenEnc, tokenIv} = j;

        Promise.all([
          _decrypt(Buffer.from(hashEnc, 'base64'), Buffer.from(hashIv, 'base64')),
          _decrypt(Buffer.from(tokenEnc, 'base64'), Buffer.from(tokenIv, 'base64')),
        ])
          .then(([
            hash,
            token,
          ]) => {
            hash = hash.toString('utf8');
            token = token.toString('base64');

            phash(req.body.password).verifyAgainst(hash, (err, verified) => {
              if (!err) {
                if (verified) {
                  res.json({
                    id,
                    username,
                    token,
                  });
                } else {
                  res.status(403);
                  res.end(http.STATUS_CODES[403]);
                }
              } else {
                res.status(500);
                res.end(err.stack);
              }
            });
          });
      } else if (err.code === 'NoSuchKey') {
        const {username, password} = req.body;

        if (/^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(username)) {
          phash(password).hash((err, hash) => {
            if (!err) {
              const {username} = req.body;
              const id = crypto.randomBytes(16).toString('base64');
              const hashIv = crypto.randomBytes(128/8).toString('base64');
              const token = crypto.randomBytes(32).toString('base64');
              const tokenIv = crypto.randomBytes(128/8).toString('base64');

              Promise.all([
                _encrypt(Buffer.from(hash, 'utf8'), Buffer.from(hashIv, 'base64')),
                _encrypt(Buffer.from(token, 'base64'), Buffer.from(tokenIv, 'base64')),
              ])
                .then(([
                  hashEnc,
                  tokenEnc,
                ]) => {
                  hashEnc = hashEnc.toString('base64');
                  tokenEnc = tokenEnc.toString('base64');

                  s3.putObject({
                    Bucket: BUCKET,
                    Key: path.join('_users', username),
                    ContentType: 'application/json',
                    Body: JSON.stringify({id, username, hashEnc, hashIv, tokenEnc, tokenIv}),
                  }, err => {
                    if (!err) {
                      res.json({
                        id,
                        username,
                        token,
                      });
                    } else {
                      res.status(500);
                      res.end(err.stack);
                    }
                  });
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
      } else {
        res.status(500);
        res.end(err.stack);
      }
    });
  } else if (req.body && typeof req.body.username === 'string' && typeof req.body.token === 'string') {
    s3.getObject({
      Bucket: BUCKET,
      Key: path.join('_users', req.body.username),
    }, (err, result) => {
      if (!err) {
        const j = JSON.parse(result.Body.toString('utf8'));
        const {id, username, hashEnc, hashIv, tokenEnc, tokenIv} = j;

        _decrypt(Buffer.from(tokenEnc, 'base64'), Buffer.from(tokenIv, 'base64'))
          .then(token => {
            token = token.toString('base64');

            if (token === req.body.token) {
              res.json({
                id,
                username,
                token,
              });
            } else {
              res.status(403);
              res.end(http.STATUS_CODES[403]);
            }
          });
      } else if (err.code === 'NoSuchKey') {
        res.status(404);
        res.end(http.STATUS_CODES[404]);
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
        ContentType: mime.getType(p),
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
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Token\s+(\S+)\s+(\S+)$/i);
  if (match) {
    const username = match[1];
    const token = match[2];

    _requestUserFromUsernameToken(username, token)
      .then(user => {
        tmp.dir((err, p, cleanup) => {
          const us = req.pipe(zlib.createGunzip());
          us.on('error', err => {
            res.status(500);
            res.end(err.stack);
            cleanup();
          });
          const ws = us.pipe(tarFs.extract(p, {
            dmode: 0555,
            fmode: 0444,
          }));

          ws.on('finish', () => {
            const packageJsonPath = path.join(p, 'package.json');

            fs.readFile(packageJsonPath, (err, s) => {
              if (!err) {
                const packageJson = JSON.parse(s);
                let {name, version, main, browser} = packageJson;
                name = name.replace(/\//g, ':');

                if (typeof name === 'string' && semver.valid(version)) {
                  _getProject(name)
                    .then(projectSpec => {
                      if (!projectSpec || (projectSpec.owner === user.id && !projectSpec.versions.includes(version))) {
                        console.log('install module', {name, version});

                        const yarnProcess = child_process.spawn(
                          process.argv[0],
                          [
                            yarnPath,
                            'install',
                            '--production',
                            '--mutex', 'file:' + path.join(os.tmpdir(), '.webmr-registry-yarn-lock'),
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
                              .then(([codeEs, codeCjs]) => {
                                const fileName = fileSpec[0].replace(/\.[^\/]+$/, '');

                                return Promise.all([
                                  new Promise((accept, reject) => {
                                    s3.putObject({
                                      Bucket: BUCKET,
                                      Key: path.join(name, version, `${fileName}.mjs`),
                                      ContentType: 'application/javascript',
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
                                      ContentType: 'application/javascript',
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
                                const owner = projectSpec ? projectSpec.owner : user.id;
                                const versions = projectSpec ? projectSpec.versions : [];
                                versions.push(version);

                                return _setProject(name, {
                                  name,
                                  owner,
                                  versions,
                                });
                              })
                              .then(() => {
                                res.json({
                                  name,
                                  version,
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
                      } else if (projectSpec && projectSpec.owner !== user.id) {
                        res.status(403);
                        res.end(http.STATUS_CODES[403]);
                      } else if (projectSpec && projectSpec.versions.includes(version)) {
                        res.status(409);
                        res.end(http.STATUS_CODES[409]);
                      } else {
                        res.status(500);
                        res.end(err.stack);
                      }
                    })
                    .catch(err => {
                      res.status(500);
                      res.end(err.stack);
                    });
                } else {
                  res.status(500);
                  res.end(err.stack);
                  cleanup();
                }
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
        })
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
app.delete('/p/:name/:version', (req, res, next) => {
  const {name, version} = req.params;

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Token\s+(\S+)\s+(\S+)$/i);
  if (match) {
    const username = match[1];
    const token = match[2];

    _requestUserFromUsernameToken(username, token)
      .then(user => {
        _getProject(name)
          .then(projectSpec => {
            if (projectSpec) {
              let index = -1;
              if (projectSpec.owner === user.id && ((index = projectSpec.versions.indexOf(version)) !== -1)) {
                const {owner, versions} = projectSpec;
                versions.splice(index, 1);

                _setProject(name, {
                  name,
                  owner,
                  versions,
                })
                  .then(() => {
                    s3.listObjects({
                      Bucket: BUCKET,
                      Prefix: `${name}/${version}/`,
                    }, (err, data) => {
                      if (!err) {
                        const {Contents: contents} = data;
                        s3.deleteObjects({
                          Bucket: BUCKET,
                          Delete: {
                            Objects: contents.map(({Key}) => ({Key})),
                          },
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
                  })
                  .catch(err => {
                    res.status(500);
                    res.end(err.stack);
                  });
              } else if (projectSpec.owner !== user.id) {
                res.status(403);
                res.end(http.STATUS_CODES[403]);
              } else if (index === -1) {
                res.status(404);
                res.end(http.STATUS_CODES[404]);
              } else {
                res.status(500);
                res.end(http.STATUS_CODES[500]);
              }
            } else {
              res.status(404);
              res.end(http.STATUS_CODES[404]);
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
const _uploadFile = (req, res, next) => {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Token\s+(\S+)\s+(\S+)$/i);
  if (match) {
    const username = match[1];
    const token = match[2];

    _requestUserFromUsernameToken(username, token)
      .then(() => {
        const {filename} = req.params;
        let {name} = req.params;
        if (!name) {
          name = meaningful().toLowerCase();
        }
        const key = '_files/' + username + '/' + name + '/' + filename;

        s3.upload({
          Bucket: BUCKET,
          Key: key,
          ContentType: mime.getType(filename),
          Body: req,
        }, (err, data) => {
          if (!err) {
            res.json({
              url: FILES_HOST + '/' + key,
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
};
app.put('/f/:filename', _uploadFile);
app.put('/f/:filename/:name', _uploadFile);
app.delete('/f/:name', (req, res, next) => {
  const {name} = req.params;

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Token\s+(\S+)\s+(\S+)$/i);
  if (match) {
    const username = match[1];
    const token = match[2];

    _requestUserFromUsernameToken(username, token)
      .then(() => {
        s3.listObjects({
          Bucket: BUCKET,
          Prefix: '_files/' + username + '/' + name + '/',
        }, (err, data) => {
          if (!err) {
            const {Contents: contents} = data;

            if (contents.length > 0) {
              s3.deleteObjects({
                Bucket: BUCKET,
                Delete: {
                  Objects: contents.map(({Key}) => ({Key})),
                },
              }, err => {
                if (!err) {
                  res.json({});
                } else {
                  res.status(500);
                  res.end(err.stack);
                }
              });
            } else {
              res.status(404);
              res.end(http.STATUS_CODES[404]);
            }
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
const _uploadDirectory = (req, res, next) => {
  const {dirname} = req.params;

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Token\s+(\S+)\s+(\S+)$/i);
  if (match) {
    const username = match[1];
    const token = match[2];

    _requestUserFromUsernameToken(username, token)
      .then(user => {
        tmp.dir((err, p, cleanup) => {
          const us = req.pipe(zlib.createGunzip());
          us.on('error', err => {
            res.status(500);
            res.end(err.stack);
            cleanup();
          });
          const ws = us.pipe(tarFs.extract(p, {
            dmode: 0555,
            fmode: 0444,
          }));

          ws.on('finish', async () => {
            const ig = ignore();
            let {name} = req.params;
            if (!name) {
              name = meaningful().toLowerCase();
            }
            const key = '_files/' + username + '/' + name + '/' + dirname;
            await _uploadModule('/', p, ig, key);

            res.json({
              url: HOST + '/' + key,
            });
          });
        });
      });
  } else {
    res.status(401);
    res.end(http.STATUS_CODES[401]);
  }
};
app.put('/d/:dirname', _uploadDirectory);
app.put('/d/:dirname/:name', _uploadDirectory);
const proxy = httpProxy.createProxyServer({
  autoRewrite: true,
  hostRewrite: true,
  protocolRewrite: true,
  changeOrigin: true,
});
app.get('/s', (req, res, next) => {
  req.url = '/servers';

  proxy.web(req, res, {
    target: MULTIPLAYER_HOST,
  });
});
app.post('/s/:name', (req, res, next) => {
  const {name} = req.params;
  req.url = `/servers/${name}`;

  proxy.web(req, res, {
    target: MULTIPLAYER_HOST,
  });
});
app.delete('/s/:name', (req, res, next) => {
  const {name} = req.params;
  req.url = `/servers/${name}`;

  proxy.web(req, res, {
    target: MULTIPLAYER_HOST,
  });
});
app.get('/u/:id/:key', async (req, res, next) => {
  const {id, key} = req.params;
  const k = id + '/' + key;
  const b = await rcGetAsync(k);

  if (b !== null) {
    res.type('application/octet-stream');
    res.end(b);
  } else {
    res.status(404);
    res.end(http.STATUS_CODES[404]);
  }
});
app.put('/u/:id/:key', bodyParserBuffer, async (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    const {id, key} = req.params;
    const k = id + '/' + key;
    await rcSetAsync(k, req.body);

    res.json({});
  } else {
    res.status(400);
    res.end(http.STATUS_CODES[400]);
  }
});
app.get('/multiplayer', (req, res, next) => {
  res.redirect(MULTIPLAYER_HOST);
});
app.get('/*', (req, res, next) => {
  let p = req.params[0];
  if (!/\/$/.test(p)) {
    p += '/';
  }
  if (p === '/') {
    p = '';
  }

  s3.listObjects({
    Bucket: BUCKET,
    Prefix: p,
    Delimiter: '/',
  }, (err, data) => {
    if (!err) {
      const {CommonPrefixes: commonPrefixes} = data;
      commonPrefixes.push({
        Prefix: p,
      });

      const files = [];
      const filesIndex = {};
      Promise.all(commonPrefixes.map(commonPrefix => new Promise((accept, reject) => {
        s3.listObjects({
          Bucket: BUCKET,
          Prefix: commonPrefix.Prefix,
        }, (err, data) => {
          if (!err) {
            const {Contents: contents} = data;

            const regex = new RegExp('(' + escapeRegExp(p) + '[^/]+?(?:/|$))');
            for (let i = 0; i < contents.length; i++) {
              const content = contents[i];
              const {Key: key, LastModified: timestamp} = content;
              let match;
              if (match = key.match(regex)) {
                const name = match[1];

                if (!filesIndex[name]) {
                  files.push({
                    name,
                    timestamp,
                  });
                  filesIndex[name] = true;
                }
              }
            }

            accept();
          } else {
            reject(err);
          }
        });
      })))
        .then(() => {
          const isDirectory = s => /\/$/.test(s);
          const pHtml = (() => {
            let result = `/<a href="${encodeURI(HOST)}/">root</a>/`;
            const components = p.split('/');
            let acc = `${HOST}/`;
            for (let i = 0; i < components.length; i++) {
              const component = components[i];

              if (component) {
                acc += component + '/';
                const uri = encodeURI(acc);
                result += `<a href="${uri}">${component}</a>/`;
              }
            }
            return result;
          })();
          let html = `<!doctype html><html><body><h1>${pHtml}</h1>`;
          files.sort((a, b) => {
            const aIsDirectory = isDirectory(a.name);
            const bIsDirectory = isDirectory(b.name);
            let diff = +bIsDirectory - +aIsDirectory;
            if (diff !== 0) {
              return diff;
            } else {
              let diff = (aIsDirectory || bIsDirectory) ? (+b.timestamp - +a.timestamp) : 0;
              if (diff !== 0) {
                return diff;
              } else {
                return a.name.localeCompare(b.name);
              }
            }
          });
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const {name} = file;

            let uri;
            let text;
            if (isDirectory(name)) {
              uri = encodeURI(`${HOST}/${name}`);
              text = '📁\xa0/' + escape(name);
            } else {
              uri = encodeURI(`${FILES_HOST}/${name}`);
              text = '💾\xa0/' + escape(name);
            }
            html += `<a href="${uri}">${text}</a><br>`;
          }
          html += `</body></html>`;
          res.type('text/html');
          res.end(html);
        })
        .catch(err => {
          res.status(500);
          res.end(err.stack);
        });
    } else {
      res.status(500);
      res.end(err.stack);
    }
  });
});
function escapeRegExp(str) {
  return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}
const _cors = (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
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
