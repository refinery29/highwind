import 'babel-polyfill';
import fs from 'fs';
import nock from 'nock';
import request from 'supertest';
import { expect } from 'chai';
import { spy as spyOn } from 'sinon';
import { start, close } from '../src/mock_api.js';

const PROD_ROOT_URL = 'http://localhost:4444';
const RESPONSES_DIR = `${__dirname}/responses`;
const JSONP_CALLBACK = '?callback=test';
const IGNORED_QUERY_PARAMS = '?queryStringIgnore=test';
const DEFAULT_OPTIONS = {
  prodRootURL: PROD_ROOT_URL,
  fixturesPath: RESPONSES_DIR,
  queryStringIgnore: [
    new RegExp(`\\${IGNORED_QUERY_PARAMS}$`)
  ],
  quiet: true
};

describe('start()', function() {
  describe('Initialization', function() {
    it('calls the passed in callback with an error when fixturesPath is not specified', function(done) {
      start({
        prodRootURL: 'http://www.refinery29.com'
      }, (err) => {
        expect(err).to.be.an('error');
        done();
      });
    });

    it('calls the passed in callback with an error when prodRootUrl is not specified', function(done) {
      start({
        fixturesPath: './fixtures'
      }, (err) => {
        expect(err).to.be.an('error');
        done();
      });
    });

    it('does not pass in an error, and populates result.app and result.servers when prodRootURL and fixturesPath are specified', function(done) {
      start({
        prodRootURL: 'http://www.refinery29.com',
        fixturesPath: './fixtures'
      }, (err, result) => {
        expect(err).to.not.exist;

        const { app, servers } = result;
        expect(app).to.be.a('function');
        expect(servers).to.have.length(1);

        const [ server ] = servers;
        expect(server.port).to.equal(4567);
        expect(server.server).to.be.a('object');
        expect(server.active).to.be.true;

        close(servers, done);
      });
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

        describe('When the request method is GET', function() {
          describe('And the saveFixtures setting is set to true', function() {
            beforeEach(function(done) {
              nock(PROD_ROOT_URL)
                .get(route)
                .query(true)
                .reply(200, response);

              start(DEFAULT_OPTIONS, (err, result) => {
                mockAPI = result;
                done();
              });
            });

            afterEach(function() {
              close(mockAPI.servers);
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
                .expect(200)
                .end((err, res) => {
                  expect(res.text).to.equal(JSON.stringify(response));
                  fs.access(responsePath, fs.F_OK, done);
                });
            });

            it('truncates ignored query string expressions in the persisted response filename', function(done) {
              request(mockAPI.app)
                .get(route + IGNORED_QUERY_PARAMS)
                .expect('Content-Type', /application\/json/)
                .expect(200)
                .end((err, res) => {
                  expect(res.text).to.equal(JSON.stringify(response));
                  fs.access(responsePath, fs.F_OK, done);
                });
            });

            it('renders the endpoint as JSONP when a callback is specified in the query string', function(done) {
              request(mockAPI.app)
                .get(route + JSONP_CALLBACK)
                .expect('Content-Type', /application\/javascript/)
                .expect(200)
                .end((err, res) => {
                  expect(res.text).to.equal(JSON.stringify(response));
                  fs.access(responsePathWithCallback, fs.F_OK, done);
                });
            });
          });

          describe('And the saveFixtures setting is set to false', function() {
            beforeEach(function(done) {
              nock(PROD_ROOT_URL)
                .get(route)
                .query(true)
                .reply(200, response);

              start({ ...DEFAULT_OPTIONS, saveFixtures: false }, (err, result) => {
                mockAPI = result;
                done();
              });
            });

            afterEach(function() {
              close(mockAPI.servers);
            });

            it('responses with a response from the production API and does not persist the response', function(done) {
              request(mockAPI.app)
                .get(route)
                .expect('Content-Type', /application\/json/)
                .expect(200)
                .end((err, res) => {
                  expect(res.text).to.equal(JSON.stringify(response));
                  fs.access(responsePath, fs.F_OK, (err) => {
                    if (err) {
                      return done();
                    }
                    throw new Error(
                      'Saved a fixture with saveFixtures set to false'
                    );
                  });
                });
            });
          });
        });

        describe('When the request method is not GET', function() {
          beforeEach(function(done) {
            start(DEFAULT_OPTIONS, (err, result) => {
              mockAPI = result;
              done();
            });
          });

          afterEach(function() {
            close(mockAPI.servers);
          });

          it('does not call the production API and returns an error', function(done) {
            request(mockAPI.app)
              .put(route)
              .expect(500, '', done);
          });
        });
      });

      describe('And there is a JSON response matching a given route', function() {
        let mockAPI;
        const route = '/persisted_json_route';
        const responsePath = RESPONSES_DIR + route + '.json';
        const responsePathWithCallback = RESPONSES_DIR + route + JSONP_CALLBACK + '.json';
        const jsonResponse = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
        const jsonpResponse = fs.readFileSync(responsePathWithCallback, 'utf8');

        beforeEach(function(done) {
          nock(PROD_ROOT_URL)
            .get(route)
            .query(true)
            .replyWithError('Fake API hit the production API');

          start(DEFAULT_OPTIONS, (err, result) => {
            mockAPI = result;
            done();
          });
        });

        afterEach(function() {
          close(mockAPI.servers);
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

        before(function(done) {
          nock(PROD_ROOT_URL)
            .get(route)
            .replyWithError('Fake API hit the production API');

          start(DEFAULT_OPTIONS, (err, result) => {
            mockAPI = result;
            done();
          });
        });

        after(function() {
          close(mockAPI.servers);
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
        const modOptions = {
          ...DEFAULT_OPTIONS,
          overrides: {
            get: [
              {
                route,
                response,
                status: 503,
                headers: { 'Content-Type': 'text/plain' }
              }
            ]
          }
        };

        before(function(done) {
          nock(PROD_ROOT_URL)
            .get(route)
            .query(true)
            .replyWithError('Fake API hit the production API');

          start(modOptions, (err, result) => {
            mockAPI = result;
            done();
          });
        });

        after(function() {
          close(mockAPI.servers);
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
        const modOptions = {
          ...DEFAULT_OPTIONS,
          overrides: {
            get: [
              {
                route,
                response
              }
            ]
          }
        };

        before(function(done) {
          nock(PROD_ROOT_URL)
            .get(route)
            .replyWithError('Fake API hit the production API');

          start(modOptions, (err, result) => {
            mockAPI = result;
            done();
          });
        });

        after(function() {
          close(mockAPI.servers);
        });

        it('responds with the specified response rendered as JSON, status 200, and does not hit the production API', function(done) {
          request(mockAPI.app)
            .get(route)
            .expect('Content-Type', /application\/json/)
            .expect(200, response, done);
        });
      });

      describe('And there is a JSON response with query param expectations specified in the override', function() {
        let mockAPI;
        const route = '/overridden_route';
        const response = { status: 'overridden response' };

        const modOptions = {
          ...DEFAULT_OPTIONS,
          overrides: {
            get: [
              {
                route,
                response,
                withQueryParams: { foo: 'bar' }
              }
            ]
          }
        };

        before(function(done) {
          nock(PROD_ROOT_URL)
            .get(route)
            .replyWithError('Fake API hit the production API');

          start(modOptions, (err, result) => {
            mockAPI = result;
            done();
          });
        });

        after(function() {
          close(mockAPI.servers);
        });

        describe('when the query params are specified in the route', function() {
          it('responds with the specified response, status 200, and does not hit the production API', function(done) {
            request(mockAPI.app)
              .get(route + '?foo=bar')
              .expect('Content-Type', /application\/json/)
              .expect(200, response, done);
          });
        });

        describe('when the query params are not specified in the route', function() {
          it('does not respond with the specified response, status 200, and does not hit the production API', function(done) {
            request(mockAPI.app)
              .get(route + '?foo=quux')
              .expect(500, '', done);
          });
        });
      });

      describe('And there is a JSON response with a mergeParmas callback specified in the override', function() {
        let mockAPI;
        const route = '/overridden_route';
        const reqBody = { merged: 'merged body' };
        const response = { status: 'overridden response' };
        const modOptions = {
          ...DEFAULT_OPTIONS,
          overrides: {
            post: [
              {
                route,
                response,
                mergeParams: (response, params) => ({ ...response, ...params })
              }
            ]
          }
        };

        before(function(done) {
          nock(PROD_ROOT_URL)
            .post(route)
            .replyWithError('Fake API hit the production API');

          start(modOptions, (err, result) => {
            mockAPI = result;
            done();
          });
        });

        after(function() {
          close(mockAPI.servers);
        });

        it('responds with the specified response rendered as JSON, status 200, and does not hit the production API', function(done) {
          request(mockAPI.app)
            .post(route)
            .send(reqBody)
            .expect('Content-Type', /application\/json/)
            .expect(200, { ...response, ...reqBody }, done);
        });
      });
    });
  });
});

describe('close()', function() {
  it('calls the callback with an error if there are no servers', function(done) {
    close(null, (err) => {
      expect(err).to.be.an('error');
      done();
    });
  });

  describe('when there are only inactive servers', function() {
    before(function(done) {
      const ports = [5000, 5001, 5002];
      const modOptions = { ...DEFAULT_OPTIONS, ports };
      start(modOptions, (err, result) => {
        close(result.servers, done);
      });
    });

    it('calls the callback with an error if there are only inactive servers', function(done) {
      close(null, (err) => {
        expect(err).to.be.an('error');
        done();
      });
    });
  });

  describe('without explicitly passing in servers', function() {
    let ports, servers;

    beforeEach(function(done) {
      ports = [1111, 1112, 1113];
      const modOptions = { ...DEFAULT_OPTIONS, ports };
      start(modOptions, (err, result) => {
        servers = result.servers;
        done();
      });
    });

    it('marks all running servers as inactive', function(done) {
      close(null, () => {
        expect(servers.filter(server => server.active)).to.have.length(0);
        done();
      });
    });
  });

  describe('explicitly passing in servers', function() {
    it('marks all servers passed to it as inactive', function(done) {
      const mockServer = {
        close(callback) {
          return callback();
        }
      };
      spyOn(mockServer, 'close');
      const servers = [
        {
          port: 4567,
          server: mockServer,
          active: true
        }
      ];
      close(servers, () => {
        expect(mockServer.close).to.have.been.called;
        expect(servers.filter(server => server.active)).to.have.length(0);
        done();
      });
    });
  });
});
