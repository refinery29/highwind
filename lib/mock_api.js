'use strict';

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

var _express = require('express');

var _express2 = _interopRequireDefault(_express);

var _cors = require('cors');

var _cors2 = _interopRequireDefault(_cors);

var _nodeFetch = require('node-fetch');

var _nodeFetch2 = _interopRequireDefault(_nodeFetch);

var _bodyParser = require('body-parser');

var _bodyParser2 = _interopRequireDefault(_bodyParser);

var _url = require('url');

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var PROD_ROOT_URL = undefined;
var FIXTURES_PATH = undefined;
var QUERY_STRING_IGNORE = undefined;
var SERVERS = {};
var REQUIRED_CONFIG_OPTIONS = ['prodRootURL', 'fixturesPath'];

module.exports = {
  start: function start(options) {
    throwIfMissingOptions(options);
    var app = (0, _express2.default)();
    var defaults = {
      ports: [4567],
      encoding: 'utf8',
      queryStringIgnore: [],
      quiet: false
    };
    var modOptions = _extends({}, defaults, options);
    var prodRootURL = modOptions.prodRootURL;
    var corsWhitelist = modOptions.corsWhitelist;
    var fixturesPath = modOptions.fixturesPath;
    var overrides = modOptions.overrides;
    var queryStringIgnore = modOptions.queryStringIgnore;
    var ports = modOptions.ports;
    var encoding = modOptions.encoding;
    var quiet = modOptions.quiet;

    PROD_ROOT_URL = prodRootURL;
    FIXTURES_PATH = fixturesPath;
    QUERY_STRING_IGNORE = queryStringIgnore;

    if (corsWhitelist) {
      setCorsMiddleware(app, corsWhitelist);
    }
    if (overrides) {
      delegateRouteOverrides(app, overrides, encoding);
    }
    app.get('*', function (req, res) {
      var path = getURLPathWithQueryString(req);
      var fileName = getFileName(path);
      _fs2.default.readFile(fileName, encoding, function (err, data) {
        if (err) {
          recordFromProd(req, res);
        } else {
          serveLocalResponse(res, fileName, data, { quiet: quiet });
        }
      });
    });
    startListening(app, ports);
    return {
      app: app,
      servers: SERVERS
    };
  },
  close: function close(clientServers) {
    var servers = clientServers || SERVERS;
    var ports = Object.keys(servers);
    if (!ports.length) {
      throw Error('closeMockAPI invoked without arguments or open servers');
    }
    ports.forEach(function (port) {
      console.info('Closing mock API server on port ' + port);
      servers[port].close();
      delete servers[port];
    });
  }
};

function throwIfMissingOptions(options) {
  REQUIRED_CONFIG_OPTIONS.forEach(function (key) {
    if (typeof options[key] !== 'string') {
      throw Error('Missing definition of ' + key + ' in config file');
    }
  });
}

function setCorsMiddleware(app, whitelist) {
  var corsOptions = {
    origin: function origin(_origin, callback) {
      var originIsWhitelisted = whitelist.includes(_origin);
      callback(null, originIsWhitelisted);
    },

    credentials: true
  };
  var corsMiddleware = (0, _cors2.default)(corsOptions);
  app.use(corsMiddleware);
}

function startListening(app, ports) {
  ports.forEach(function (port) {
    if (SERVERS.hasOwnProperty(port)) {
      console.warn('Port ' + port + ' specified more than once in config file');
      return;
    }
    var server = app.listen(port, function (err) {
      if (err) {
        console.error(err);
      } else {
        console.info('Mock API server listening on port ' + port);
      }
    });
    SERVERS[port] = server;
  });
}

function delegateRouteOverrides(app, overrides, encoding) {
  var methods = ['get', 'post', 'put', 'delete', 'all'];
  var defaults = {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  };
  var jsonMiddleware = [_bodyParser2.default.json(), _bodyParser2.default.urlencoded({ extended: true })];

  Object.keys(overrides).forEach(function (method) {
    if (!methods.includes(method)) {
      throw Error('Couldn\'t override route with invalid HTTP method: \'' + method + '\'');
    }
    overrides[method].forEach(function (params) {
      var fixture = undefined;
      var routeParams = _extends({}, defaults, params);
      var route = routeParams.route;
      var status = routeParams.status;
      var response = routeParams.response;
      var headers = routeParams.headers;
      var mergeParams = routeParams.mergeParams;

      var responseIsJson = /(javascript|json)/.test(headers['Content-Type']);

      if (!route) {
        throw Error('Encountered an HTTP method override without a specified route');
      }

      if (!response) {
        var fileName = getFileName(route);
        _fs2.default.readFile(fileName, encoding, function (err, data) {
          if (err) {
            throw Error('Route override specified for \'' + route + '\' with no response or matching fixture');
          } else {
            fixture = data;
          }
        });
      } else if (responseIsJson) {
        fixture = JSON.stringify(response);
      } else {
        fixture = response;
      }

      app[method].call(app, route, jsonMiddleware, function (req, res) {
        console.info('==> 📁  Serving local fixture for ' + method.toUpperCase() + ' -> \'' + route + '\'');
        var payload = responseIsJson && typeof mergeParams === 'function' ? mergeParams(JSON.parse(fixture), req.body) : fixture;
        res.status(status).set(headers).send(payload);
      });
    });
  });
}

function recordFromProd(req, res) {
  var responseIsJson = undefined;
  var path = getURLPathWithQueryString(req);
  var prodURL = getProdURL(path);
  var responseIsJsonp = prodURL.match(/callback\=([^\&]+)/);

  console.info('==> 📡  GET ' + PROD_ROOT_URL + ' -> ' + path);
  (0, _nodeFetch2.default)(prodURL).then(function (response) {
    if (response.ok) {
      console.info('==> 📡  STATUS ' + response.status);
    } else {
      throw Error('Couldn\'t complete fetch with status ' + response.status);
    }

    var contentType = response.headers.get('Content-Type');
    responseIsJson = contentType.match(/(javascript|json)/) && !responseIsJsonp;
    if (responseIsJson) {
      return response.json();
    } else if (responseIsJsonp || contentType.match(/text/)) {
      return response.text();
    } else {
      throw Error('Couldn\'t complete fetch with Content-Type \'' + contentType + '\'');
    }
  }).then(function (response) {
    var fileName = getFileName(path);
    var data = responseIsJson ? JSON.stringify(response) : response;

    _fs2.default.writeFile(fileName, data, function (err) {
      if (err) {
        throw Error('Couldn\'t write response locally, received fs error: \'' + err + '\'');
      }
      console.info('==> 💾  Saved response to ' + fileName);
    });
    serveLocalResponse(res, fileName, data, { quiet: true });
  }).catch(function (err) {
    console.error('==> ⛔️  ' + err);
    res.status(500).end();
  });
}

function serveLocalResponse(res, fileName, data) {
  var options = arguments.length <= 3 || arguments[3] === undefined ? { quiet: false } : arguments[3];
  var quiet = options.quiet;

  if (quiet !== true) {
    console.info('==> 📁  Serving local response from ' + fileName);
  }
  if (fileName.match(/callback\=/)) {
    res.set({ 'Content-Type': 'application/javascript' }).send(data);
  } else {
    try {
      res.json(JSON.parse(data));
    } catch (e) {
      res.set({ 'Content-Type': 'text/html' }).send(data);
    }
  }
}

function getFileName(path) {
  var fileNameInDirectory = QUERY_STRING_IGNORE.reduce(function (fileName, regex) {
    return fileName.replace(regex, '');
  }, path).replace(/\//, '').replace(/\//g, ':');
  return FIXTURES_PATH + '/' + fileNameInDirectory + '.json';
}

function getProdURL(path) {
  return PROD_ROOT_URL + path;
}

function getURLPathWithQueryString(req) {
  var queryString = (0, _url.parse)(req.url).query;
  if (queryString && queryString.length > 0) {
    return req.path + '?' + queryString;
  } else {
    return req.path;
  }
}