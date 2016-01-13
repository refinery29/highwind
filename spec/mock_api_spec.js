import 'babel-polyfill';
import fs from 'fs';
import nock from 'nock';
import request from 'supertest';
import { expect } from 'chai';
import { spy as spyOn } from 'sinon';
import {
  start as startMockAPI,
  close as closeMockAPI
} from '../src/mock_api.js';

const PROD_ROOT_URL = 'http://localhost:4444';
const RESPONSES_DIR = `${__dirname}/responses`;
const JSONP_CALLBACK = '?callback=test';
const IGNORED_QUERY_PARAMS = '?queryStringIgnore=test';
const DEFAULT_OPTIONS = {
  prodRootURL: PROD_ROOT_URL,
  fixturesPath: RESPONSES_DIR,
  queryStringIgnore: [ new RegExp(`\\${IGNORED_QUERY_PARAMS}$`) ],
  quiet: true
};

describe('#start', function() {
  describe('Initialization', function() {
    it('throws an error when a prodRootURL or fixturesPath are not specified', function() {
      expect(() => {
        startMockAPI({
          prodRootURL: 'http://www.refinery29.com'
        });
      }).to.throw(Error);

      expect(() => {
        startMockAPI({
          fixturesPath: './fixtures'
        });
      }).to.throw(Error);

      expect(() => {
        startMockAPI({
          prodRootURL: 'http://www.refinery29.com/',
          fixturesPath: './fixtures'
        });
      }).to.not.throw(Error);
    });
  });

  describe('Handling routes', function() {
    describe('When there is no override', function() {
      describe('And there is no response matching a given route', function() {
        let mockAPI;
        const route = '/non_persisted_json_route';
        const response = { source: 'Remote API' };
        const responsePath = RESPONSES_DIR + route + '.json';
        const responsePathWithCallback = RESPONSES_DIR + route + JSONP_CALLBACK + '.json';

        beforeEach(function() {
          mockAPI = startMockAPI(DEFAULT_OPTIONS);
          nock(PROD_ROOT_URL)
            .get(route)
            .query(true)
            .reply(200, response);
        });

        afterEach(function() {
          closeMockAPI(mockAPI.servers);
          [responsePath, responsePathWithCallback].forEach(path => {
            try {
              fs.accessSync(path, fs.F_OK);
            } catch (e) {
              return;
            }
            fs.unlinkSync(path);
          });
        });

        it('persists and responds with a response from the production API', function(done) {
          request(mockAPI.app)
            .get(route)
            .expect('Content-Type', /application\/json/)
            .expect(200, response, () => fs.access(responsePath, fs.F_OK, done));
        });

        it('truncates ignored query string expressions in the persisted response filename', function(done) {
          request(mockAPI.app)
            .get(route + IGNORED_QUERY_PARAMS)
            .expect('Content-Type', /application\/json/)
            .expect(200, response, () => fs.access(responsePath, fs.F_OK, done));
        });

        it('renders the endpoint as JSONP when a callback is specified in the query string', function(done) {
          request(mockAPI.app)
            .get(route + JSONP_CALLBACK)
            .expect('Content-Type', /application\/javascript/)
            .expect(200, response, () => fs.access(responsePathWithCallback, fs.F_OK, done));
        });
      });

      describe('And there is a JSON response matching a given route', function() {
        let mockAPI;
        const route = '/persisted_json_route';
        const responsePath = RESPONSES_DIR + route + '.json';
        const responsePathWithCallback = RESPONSES_DIR + route + JSONP_CALLBACK + '.json';
        const jsonResponse = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
        const jsonpResponse = fs.readFileSync(responsePathWithCallback, 'utf8');

        beforeEach(function() {
          mockAPI = startMockAPI(DEFAULT_OPTIONS);
          nock(PROD_ROOT_URL)
            .get(route)
            .query(true)
            .replyWithError('Fake API hit the production API');
        });

        afterEach(function() {
          closeMockAPI(mockAPI.servers);
        });

        it('serves the locally persisted response as JSON and does not hit the production API', function(done) {
          request(mockAPI.app)
            .get(route)
            .expect('Content-Type', /application\/json/)
            .expect(200, jsonResponse, done);
        });

        it('ignores truncated query string expressions when identifying the persisted response filename and does not hit the production API', function(done) {
          request(mockAPI.app)
            .get(route + IGNORED_QUERY_PARAMS)
            .expect('Content-Type', /application\/json/)
            .expect(200, jsonResponse, done);
        });

        it('renders the endpoint as JSONP when a callback is specified in the query string and does not hit the production API', function(done) {
          request(mockAPI.app)
            .get(route + JSONP_CALLBACK)
            .expect('Content-Type', /application\/javascript/)
            .expect(200, jsonpResponse, done);
        });
      });

      describe('And there is a non-JSON response matching a given route', function() {
        let mockAPI;
        const route = '/persisted_html_route';
        const responsePath = RESPONSES_DIR + route + '.json';
        const response = fs.readFileSync(responsePath, 'utf8');

        before(function() {
          mockAPI = startMockAPI(DEFAULT_OPTIONS);
          nock(PROD_ROOT_URL)
            .get(route)
            .replyWithError('Fake API hit the production API');
        });

        after(function() {
          closeMockAPI(mockAPI.servers);
        });

        it('responds with the locally persisted response as `text/html` and does not hit the production API', function(done) {
          request(mockAPI.app)
            .get(route)
            .expect('Content-Type', /text\/html/)
            .expect(200, response, done);
        });
      });
    });

    describe('When there is an override for a given route', function() {
      describe('And there is a response with header params specified in the override', function() {
        let mockAPI;
        const route = '/overridden_route';
        const response = 'overridden response';
        const modOptions = Object.assign({}, DEFAULT_OPTIONS, {
          overrides: {
            get: [
              {
                route: route,
                response: response,
                status: 503,
                headers: {
                  'Content-Type': 'text/plain'
                }
              }
            ]
          }
        });

        before(function() {
          mockAPI = startMockAPI(modOptions);
          nock(PROD_ROOT_URL)
            .get(route)
            .query(true)
            .replyWithError('Fake API hit the production API');
        });

        after(function() {
          closeMockAPI(mockAPI.servers);
        });

        it('responds with the specified response, status, and headers and does not hit the production API', function(done) {
          request(mockAPI.app)
            .get(route)
            .expect('Content-Type', /text\/plain/)
            .expect(503, response, done);
        });

        it('responds with the specified headers even if the filename specifies a JSONP callback', function(done) {
          request(mockAPI.app)
            .get(route + JSONP_CALLBACK)
            .expect('Content-Type', /text\/plain/, done);
        });
      });

      describe('And there is a JSON response with no header params specified in the override', function() {
        let mockAPI;
        const route = '/overridden_route';
        const response = { status: 'overridden response' };
        const modOptions = Object.assign({}, DEFAULT_OPTIONS, {
          overrides: {
            get: [
              {
                route: route,
                response: response
              }
            ]
          }
        });

        before(function() {
          mockAPI = startMockAPI(modOptions);
          nock(PROD_ROOT_URL)
            .get(route)
            .replyWithError('Fake API hit the production API');
        });

        after(function() {
          closeMockAPI(mockAPI.servers);
        });

        it('responds with the specified response rendered as JSON, status 200, and does not hit the production API', function(done) {
          request(mockAPI.app)
            .get(route)
            .expect('Content-Type', /application\/json/)
            .expect(200, response, done);
        });
      });

      describe('And there is a JSON response with a mergeParmas callback specified in the override', function() {
        let mockAPI;
        const route = '/overridden_route';
        const reqBody = { merged: 'merged body' };
        const response = { status: 'overridden response' };
        const modOptions = Object.assign({}, DEFAULT_OPTIONS, {
          overrides: {
            post: [
              {
                route: route,
                response: response,
                mergeParams(response, params) {
                  return Object.assign({}, response, params);
                }
              }
            ]
          }
        });

        before(function() {
          mockAPI = startMockAPI(modOptions);
          nock(PROD_ROOT_URL)
            .post(route)
            .replyWithError('Fake API hit the production API');
        });

        after(function() {
          closeMockAPI(mockAPI.servers);
        });

        it('responds with the specified response rendered as JSON, status 200, and does not hit the production API', function(done) {
          request(mockAPI.app)
            .post(route)
            .send(reqBody)
            .expect('Content-Type', /application\/json/)
            .expect(200, Object.assign({}, response, reqBody), done);
        });
      });
    });
  });
});

describe('#close', function() {
  describe('without arguments', function() {
    it('closes and garbage collects all servers instantiated by startMockAPI', function() {
      const ports = [1000, 2000, 3000];
      const modOptions = Object.assign({}, DEFAULT_OPTIONS, {
        ports: ports
      });
      const { servers } = startMockAPI(modOptions);
      const closedServers = [];

      ports.forEach(port => servers[port].on('close', () => closedServers.push(port)));
      closeMockAPI();
      global.setInterval(1, () => {
        expect(ports).to.deep.equal(closedServers);
        expect(servers).to.deep.equal({});
      });
    });

    it('throws an error unless startMockAPI has been previously invoked', function() {
      expect(closeMockAPI).to.throw(Error);
    });
  });

  describe('with arguments', function() {
    it('closes and garbage collects all servers passed to it', function() {
      const mockServer = {
        close() {}
      };
      spyOn(mockServer, 'close');
      const servers = {
        4567: mockServer
      };
      expect(mockServer.close).to.have.been.called;
      closeMockAPI(servers);
      global.setInterval(1, () => {
        expect(servers).to.deep.equal({});
      });
    });
  });
});
