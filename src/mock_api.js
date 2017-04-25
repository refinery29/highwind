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
      const fileName = getFileName(path, settings);
      fs.readFile(fileName, encoding, (err, data) => {
        if (err) {
          fetchResponse(req, res, { ...settings, fileName, path });
        } else {
          serveResponse(res, { ...settings, fileName, data });
        }
      });
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
    if (!methods.includes(method)) {
      throw Error(`Couldn't override route with invalid HTTP method: '${method}'`);
    }
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
        const fileName = getFileName(route, options);
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

function fetchResponse(req, res, options) {
  if (req.method !== 'GET') {
    console.error(`==> ⛔️  Couldn't complete fetch with non-GET method`);
    return res.status(500).end();
  }

  let responseIsJson;
  const { prodRootURL, saveFixtures, path, fileName } = options;
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
    .then(response => {
      if (saveFixtures) {
        saveFixture(fileName, response, responseIsJson);
      }
      serveResponse(res, { ...options, newResponse: true });
    })
    .catch(err => {
      console.error(`==> ⛔️  ${err}`);
      res.status(500).end();
    });
}

function serveResponse(res, options) {
  const { data, fileName, quiet, newResponse } = options;
  if (!quiet && !newResponse) {
    console.info(`==> 📁  Serving local response from ${fileName}`);
  }
  if (fileName.match(/callback\=/)) {
    res
      .set({ 'Content-Type': 'application/javascript' })
      .send(data);
  } else {
    try {
      res.json(JSON.parse(data));
    } catch (e) {
      res
        .set({ 'Content-Type': 'text/html' })
        .send(data);
    }
  }
}

function saveFixture(fileName, response, responseIsJson) {
  const data = responseIsJson
    ? JSON.stringify(response)
    : response;

  fs.writeFile(fileName, data, (err) => {
    if (err) {
      throw Error(`Couldn't write response locally, received fs error: '${err}'`)
    }
    console.info(`==> 💾  Saved response to ${fileName}`);
  });
}

function getFileName(path, options) {
  const { queryStringIgnore, fixturesPath } = options;
  const fileNameInDirectory = queryStringIgnore
    .reduce((fileName, regex) => fileName.replace(regex, ''), path)
    .replace(/\//, '')
    .replace(/\//g, ':');
  return `${fixturesPath}/${fileNameInDirectory}.json`;
}

function getURLPathWithQueryString(req) {
  const queryString = url.parse(req.url).query;

  if (queryString && queryString.length > 0) {
    return req.path + '?' + queryString;
  } else {
    return req.path;
  }
}
