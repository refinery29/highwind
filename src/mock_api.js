import 'babel-polyfill';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import url from 'url';
import fs from 'fs';
import { parallel } from 'async';

const SERVERS = [];
const REQUIRED_CONFIG_OPTIONS = [
  'prodRootURL',
  'fixturesPath'
];
const DEFAULT_OPTIONS = {
  encoding: 'utf8',
  latency: 0,
  ports: [4567],
  queryStringIgnore: [],
  quiet: false,
  saveFixtures: true
};
const JSON_CONTENT_TYPE_REGEXP = /javascript|json/;

module.exports = {
  start(options, callback) {
    const error = generateMissingParamsError(options, callback);
    if (error) {
      return callback(error);
    }

    const app = express();
    const settings = { ...DEFAULT_OPTIONS, ...options };
    const { corsWhitelist, encoding, latency, overrides, ports } = settings;

    if (corsWhitelist) {
      setCorsMiddleware(app, corsWhitelist);
    }

    if (isValidDuration(latency)) {
      simulateLatency(app, latency);
    }

    if (overrides) {
      delegateRouteOverrides(app, settings);
    }

    app.all('*', (req, res) => {
      const path = getURLPathWithQueryString(req);
      const jsonFileName = getFileName(path, 'json', settings);
      const jsFileName = getFileName(path, 'js', settings);
      const htmlFileName = getFileName(path, 'html', settings);
      // Handles JSON, JS, and HTML files.
      // If the file is not found, fetch a JSON response from production.
      if(fs.existsSync(jsonFileName)) {
        fs.readFile(jsonFileName, encoding, (err, data) => {
          serveResponse(res, data, jsonFileName, { ...settings });
        });
      } else if(fs.existsSync(jsFileName)) {
        delete require.cache[require.resolve(jsFileName)] // clear cache to keep JS require dynamic
        const data = require(jsFileName).default();
        serveResponse(res, data, jsFileName, { ...settings });
      } else if(fs.existsSync(htmlFileName)) {
        fs.readFile(htmlFileName, encoding, (err, data) => {
          serveResponse(res, data, htmlFileName, { ...settings });
        });
      } else {
        fetchResponse(req, res, jsonFileName, { ...settings, path });
      }
    });

    const result = {
      app,
      servers: SERVERS
    };

    return startListening(app, ports, (err) => callback(err, result));
  },

  close(clientServers, callback) {
    const servers = clientServers || SERVERS;
    const activeServers = servers.filter(server => server.active);
    if (activeServers.length === 0) {
      return callback(Error('close() invoked without arguments or open servers'));
    }
    const tasks = activeServers.map(serverEntry => {
      const { server, port } = serverEntry;

      return (callback) => {
        console.info(`Closing mock API server on port ${port}`);
        return server.close(err => {
          serverEntry.active = false;
          callback(err);
        });
      };
    });
    return parallel(tasks, callback);
  }
}

function isValidDuration(latency) {
  return Number.isFinite(latency) && latency > 0;
}

function generateMissingParamsError(options, callback) {
  if (typeof callback !== 'function') {
    return new Error('Missing callback');
  }

  for (const key of REQUIRED_CONFIG_OPTIONS) {
    if (typeof options[key] !== 'string') {
      return new Error(`Missing definition of ${key} in config file`);
    }
  }

  return null;
}

function setCorsMiddleware(app, whitelist) {
  const corsOptions = {
    origin(origin, callback) {
      const originIsWhitelisted = whitelist.includes(origin);
      callback(null, originIsWhitelisted);
    },
    credentials: true
  };
  const corsMiddleware = cors(corsOptions);
  app.use(corsMiddleware);
}

function simulateLatency(app, latency) {
  const latencyMiddleware = (_req, _res, next) =>
    global.setTimeout(next, latency);

  app.use(latencyMiddleware);
}

function startListening(app, ports, callback) {
  const tasks = ports.map(port => {
    return (callback) => {
      const activeServers = SERVERS.filter(server => server.active);
      if (activeServers.map(server => server.port).includes(port)) {
        console.warn(`Port ${port} specified more than once in config file`);
        return;
      }
      const server = app.listen(port, (err) => {
        if (err) {
          callback(err);
        } else {
          console.info(`Mock API server listening on port ${port}`);
          callback(null);
        }
      });
      SERVERS.push({
        port,
        server,
        active: true
      });
    }
  });
  return parallel(tasks, callback);
}


function delegateRouteOverrides(app, options) {
  // Setup default values
  const { overrides, encoding, quiet } = options;
  const methods = ['get', 'post', 'put', 'delete', 'all'];
  const defaults = {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  };
  const jsonMiddleware = [
    bodyParser.json(),
    bodyParser.urlencoded({ extended: true })
  ];

  Object.keys(overrides).forEach(method => {
    // Check for invalid protocol
    if (!methods.includes(method)) {
      throw Error(`Couldn't override route with invalid HTTP method: '${method}'`);
    }

    // Iterate through get, post, etc
    overrides[method].forEach(params => {
      let fixture;
      const routeParams = { ...defaults, ...params };
      const {
        route,
        status,
        response,
        headers,
        mergeParams,
        withQueryParams: queryParams = {}
      } = routeParams;
      const responseIsJson = JSON_CONTENT_TYPE_REGEXP.test(headers['Content-Type']);

      if (!route) {
        throw Error('Encountered an HTTP method override without a specified route');
      }

      if (!response) {
        const fileName = getFileName(route, options, 'json');
        fs.readFile(fileName, encoding, (err, data) => {
          if (err) {
            throw Error(`Route override specified for '${route}' with no response or matching fixture`);
          } else {
            fixture = data;
          }
        });
      } else if (responseIsJson) {
        fixture = JSON.stringify(response);
      } else {
        fixture = response;
      }

      app[method].call(app, route, jsonMiddleware, (req, res, next) => {
        if (!quiet) {
          console.info(`==> 📁  Serving local fixture for ${method.toUpperCase()} -> '${route}'`);
        }
        for (const [param, value] of Object.entries(queryParams)) {
          if (req.query[param] !== value) {
            return next();
          }
        }
        const payload = responseIsJson && typeof mergeParams === 'function'
          ? mergeParams(JSON.parse(fixture), req.body)
          : fixture;
        res
          .status(status)
          .set(headers)
          .send(payload);
      });
    });
  });
}

function fetchResponse(req, res, fileName, options) {
  if (req.method !== 'GET') {
    console.error(`==> ⛔️  Couldn't complete fetch with non-GET method`);
    return res.status(500).end();
  }

  let responseIsJson;
  const { prodRootURL, saveFixtures, path } = options;
  const prodURL = prodRootURL + path;
  const responseIsJsonp = prodURL.match(/callback\=([^\&]+)/);

  console.info(`==> 📡  GET ${prodRootURL} -> ${path}`);
  fetch(prodRootURL + path)
    .then(response => {
      if (response.ok) {
        console.info(`==> 📡  STATUS ${response.status}`);
      } else {
        throw Error(`Couldn't complete fetch with status ${response.status}`);
      }

      const contentType = response.headers.get('Content-Type');
      responseIsJson = (contentType.match(/(javascript|json)/) && !responseIsJsonp);
      if (responseIsJson) {
        return response.json();
      } else if (responseIsJsonp || contentType.match(/text/)) {
        return response.text();
      } else {
        throw Error(`Couldn't complete fetch with Content-Type '${contentType}'`);
      }
    })
    .then(data => {
      if (saveFixtures) {
        saveFixture(fileName, data, responseIsJson);
      }
      serveResponse(res, data, fileName, { ...options, newResponse: true });
    })
    .catch(err => {
      console.error(`==> ⛔️  ${err}`);
      res.status(500).end();
    });
}

function serveResponse(res, data, fileName, options) {
  const { quiet, newResponse } = options;

  if (!quiet && !newResponse) {
    console.info(`==> 📁  Serving local response from ${fileName}`);
  }

  if (fileName.match(/callback\=/)) {
    return res
      .set({ 'Content-Type': 'application/javascript' })
      .send(data);
  }

  if (fileName.match(/.json/)) {
    try {
      if (newResponse) {
        // data is from fetch's response.json() and does not need parsing
        return res.json(data);
      }
      // data is from fs.readFile() and needs parsing
      return res.json(JSON.parse(data));
    } catch (e) {
      console.error(`⛔️ Could not parse and serve invalid JSON: ${e}`);
      return res.json({});
    }
  }

  if (fileName.match(/.js/)) {
    return res.json(data);
  }

  if (fileName.match(/.html/)) {
    return res
      .set({ 'Content-Type': 'text/html' })
      .send(data);
  }

  console.error('⛔️ Filename extension was not recognized. Please check that your fixture ends in .js, .json, or .html!');
}

function saveFixture(fileName, response, responseIsJson) {
  const data = responseIsJson
    ? JSON.stringify(response)
    : response;

  try {
    fs.writeFile(fileName, data, () => {
      console.info(`==> 💾  Saved response to ${fileName}`);
    });
  } catch (e) {
    throw Error(`Couldn't write response locally, received fs error: '${e}'`)
  }
}

function getFileName(path, ext, options) {
  const { queryStringIgnore, fixturesPath } = options;
  const fileNameInDirectory = queryStringIgnore
    .reduce((fileName, regex) => fileName.replace(regex, ''), path)
    .replace(/\//, '')
    .replace(/\//g, ':');

  return `${fixturesPath}/${fileNameInDirectory}.${ext}`;
}

function getURLPathWithQueryString(req) {
  const queryString = url.parse(req.url).query;

  if (queryString && queryString.length > 0) {
    return req.path + '?' + queryString;
  } else {
    return req.path;
  }
}
