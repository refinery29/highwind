import 'babel-polyfill';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import { parse as urlParse } from 'url';
import fs from 'fs';

let PROD_ROOT_URL;
let FIXTURES_PATH;
let QUERY_STRING_IGNORE;
let QUIET_MODE;
const SERVERS = {};
const REQUIRED_CONFIG_OPTIONS = [
  'prodRootURL',
  'fixturesPath'
];

module.exports = {
  start(options) {
    throwIfMissingOptions(options);
    const app = express();
    const defaults = {
      ports: [4567],
      encoding: 'utf8',
      queryStringIgnore: [],
      quiet: false
    };
    const modOptions = Object.assign({}, defaults, options);
    const {
      prodRootURL,
      corsWhitelist,
      fixturesPath,
      overrides,
      queryStringIgnore,
      ports,
      encoding,
      quiet
    } = modOptions;

    PROD_ROOT_URL = prodRootURL;
    FIXTURES_PATH = fixturesPath;
    QUERY_STRING_IGNORE = queryStringIgnore;
    QUIET_MODE = quiet;

    if (corsWhitelist) {
      setCorsMiddleware(app, corsWhitelist);
    }
    if (overrides) {
      delegateRouteOverrides(app, overrides, encoding);
    }
    app.get('*', (req, res) => {
      const path = getURLPathWithQueryString(req);
      const fileName = getFileName(path);
      fs.readFile(fileName, encoding, (err, data) => {
        if (err) {
          recordFromProd(req, res);
        } else {
          serveLocalResponse(res, fileName, data, { quiet: QUIET_MODE });
        }
      });
    });
    startListening(app, ports);
    return {
      app: app,
      servers: SERVERS
    };
  },

  close(clientServers) {
    const servers = clientServers || SERVERS;
    const ports = Object.keys(servers);
    if (!ports.length) {
      throw Error('closeMockAPI invoked without arguments or open servers');
    }
    ports.forEach(port => {
      console.info(`Closing mock API server on port ${port}`);
      servers[port].close();
      delete servers[port];
    });
  }
}

function throwIfMissingOptions(options) {
  REQUIRED_CONFIG_OPTIONS.forEach(key => {
    if (typeof options[key] !== 'string') {
      throw Error(`Missing definition of ${key} in config file`);
    }
  });
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

function startListening(app, ports) {
  ports.forEach(port => {
    if (SERVERS.hasOwnProperty(port)) {
      console.warn(`Port ${port} specified more than once in config file`);
      return;
    }
    const server = app.listen(port, (err) => {
      if (err) {
        console.error(err);
      } else {
        console.info(`Mock API server listening on port ${port}`);
      }
    });
    SERVERS[port] = server;
  });
}

function delegateRouteOverrides(app, overrides, encoding) {
  const methods = ['get', 'post', 'put', 'delete', 'all'];
  const defaults = {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
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
      const routeParams = Object.assign({}, defaults, params);
      const { route, status, response, headers, mergeParams } = routeParams;
      const responseIsJson = /(javascript|json)/.test(headers['Content-Type']);

      if (!route) {
        throw Error('Encountered an HTTP method override without a specified route');
      }

      if (!response) {
        const fileName = getFileName(route);
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

      app[method].call(app, route, jsonMiddleware, (req, res) => {
        if (!QUIET_MODE) {
          console.info(`==> 📁  Serving local fixture for ${method.toUpperCase()} -> '${route}'`);
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

function recordFromProd(req, res) {
  let responseIsJson;
  const path = getURLPathWithQueryString(req);
  const prodURL = getProdURL(path);
  const responseIsJsonp = prodURL.match(/callback\=([^\&]+)/);

  console.info(`==> 📡  GET ${PROD_ROOT_URL} -> ${path}`);
  fetch(prodURL)
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
      const fileName = getFileName(path);
      const data = responseIsJson
        ? JSON.stringify(response)
        : response;

      fs.writeFile(fileName, data, (err) => {
        if (err) {
          throw Error(`Couldn't write response locally, received fs error: '${err}'`)
        }
        console.info(`==> 💾  Saved response to ${fileName}`);
      });
      serveLocalResponse(res, fileName, data, { quiet: true });
    })
    .catch(err => {
      console.error(`==> ⛔️  ${err}`);
      res.status(500).end();
    });
}

function serveLocalResponse(res, fileName, data, options = { quiet: false }) {
  const { quiet } = options;
  if (quiet !== true) {
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

function getFileName(path) {
  const fileNameInDirectory = QUERY_STRING_IGNORE
    .reduce((fileName, regex) => fileName.replace(regex, ''), path)
    .replace(/\//, '')
    .replace(/\//g, ':');
  return `${FIXTURES_PATH}/${fileNameInDirectory}.json`;
}

function getProdURL(path) {
  return PROD_ROOT_URL + path;
}

function getURLPathWithQueryString(req) {
  const queryString = urlParse(req.url).query;
  if (queryString && queryString.length > 0) {
    return req.path + '?' + queryString;
  } else {
    return req.path;
  }
}
