Highwind
========
*"There ain't no getting offa this train we on!"*

Highwind provides a simple, fast, configurable Express server that makes it easy
to simulate API responses from your production server.

Highwind will automatically pull down production data from the URL you specify and save it locally when it cannot find a fixture for the requested URL. This allows for painless feature testing, with immediately-generated response data that highly approximates your production API responses.

Highwind also comes with a bevy of configuration options that make it dead simple to specify unique response statuses and headers, dynamically mix fixture data with request body params, serve concurrently from multiple ports, and avoid redundant response caching.

## Basic Usage

Highwind provides a slim API that makes it easy to drop into a test suite or task runner:

```js
import highwind from 'highwind';

const options = {
  prodRootURL: 'http://www.refinery29.com/',
  fixturesPath: `${__dirname}/fixtures`
};

// booting your server
highwind.start(options, (err, result) => {
  // 'result.app' is the express object
  //
  // 'result.servers' represents all currently running Highwind servers,
  // and is an array of server objects with signature:
  // {
  //   port : number
  //   server : instance of the express object in 'result.app'
  //   active : bool
  // }
  //
  // The important thing to note is that by the time the callback is called,
  // result[n].server is currently listening for requests.
});

// closing your server

// first argument is an optional array of servers with the same signature
// as highwind.start's `result.servers`. If this param is not passed in,
// highwind.close will close all currently running servers.
highwind.close(null, (err) => {
  // do something after all currently running servers have been closed
});
```

Highwind only needs to know your the root URL for your production API and the
absolute path to your fixtures directory to get started.

By default, Highwind listens for requests on port **4567**. You can change that
in the [config, however](#configuration-options).

## Fixtures

You may supply your fixtures as JSON, JS, or HTML files:

#### JSON Fixture

*Filepath:* `./fixtures/myApiResponse.json`

```json
{
  "result": {
    "foo":  "bar"
    }
}
```

In this example, requesting `localhost:4567/myApiResponse` would return the above JSON.

#### HTML Fixture

*Filepath:* `./fixtures/myApiResponse.html`

```json
<html>
  <head>
    <title>Test</title>
  </head>
  <body>
  </body>
</html>
```

In this example, requesting `localhost:4567/myApiResponse` would return the above HTML.

#### JS Fixture

*Filepath:* `./fixtures/myApiResponse.js`

```js
export default () => {
  return {
    result: {
      foo: "bar"
    }
  };
}
```

In this example, requesting `localhost:4567/myApiResponse` would return the following JSON.
```json
{
  "result": {
    "foo":  "bar"
    }
}
```

## Configuration Options
These are dropped in to the options object passed to `highwind.start()` during instantiation.
* `prodRootURL` *(string, **required**)*:
  * The root production URL to serve from when the API response for a given route is not stored locally.
* `fixturesPath`: *(string, **required**)*:
  * The absolute path to the directory from which API responses are stored and served.
* `corsWhitelist` *(array of string)*:
  * An array of URLs dispatched to Express's CORS middleware.
* `overrides` *(object)*:
  * HTTP methods for which specific routes should be overridden. Each property of this object should have a key specifying an HTTP method known to Express's `app` object (`get`, `post`, `put`, `delete`, `all`). Examples follow below.
* `queryStringIgnore` *(array of RegExp)*:
  * **Default:** `[]`
  * Query string expressions to be ignored when writing/reading API responses.
  * For example, `/\?analytics=[^\&]+/` would result in a query for `/homepage` and `/homepage?analytics=true` saving and searching for the same local response fixture.
* `ports` *(array of number)*:
  * **Default:** `[4567]`
  * Ports for Highwind to listen on. Each results in a separate Express server instance.
* `encoding` *(string)*:
  * **Default:** `'utf8'`.
  * The default charset encoding passed to `fs` for reading/writing local responses.
* `quiet`: *(boolean)*
  * **Default:** `false`.
  * Silences console output when an API response is being served locally. One possible use case is feature tests, in which you'll (ideally) be serving everything locally, to minimize spec pollution.
* `saveFixtures`: *(boolean)*
  * **Default:** `true`.
  * Toggles persisting responses from the production API as local fixtures.
* `latency`: *(number)*
  * **Default:** 0
  * Number of milliseconds to delay responses in order to simulate latency.


## HTTP Route Overrides

In some instances you may want to override the behavior for a specific route.

Here are some examples of HTTP route overrides and their use cases.

### Serving a JSON response
```js
import loginFixture from './fixtures/login.json';

...

overrides: {
  post: [
    {
      route: '/api/login',
      response: loginFixture,
      status: 503
    }
  ]
}
```
This configures the mock API to respond to POST requests to `'/api/login'` with the fixture object assigned to `response` and a `503` status.

### Mixing a JSON fixture response with POST params at runtime
```js
import emailSignupFixture from './fixtures/email_signup.json';

...

overrides: {
  post: [
    {
      route: '/api/sign_up',
      response: emailSignupFixture,
      mergeParams(response, params) {
        return Object.assign({}, response, { result: params });
      }
    }
  ]
}
```
Just as in the previous example, this will result in POST requests to `'/api/sign_up'` being served the fixture assigned to `response`. The distinction here is the `mergeParams` callback. This intercepts the POST params bound to Express's `res.body` and assigns them to the `result` key of the response object (`emailSignupFixture` in this example).

### Serving a non-JSON response
```js
get: [
  {
    route: '/legacy_route',
    headers: {
      'Content-Type': 'text/html'
    }
  }
]
```
This configures the mock API to respond to `get` requests for `/legacy_route` with a non-JSON `'Content-Type'` header. This also prevents the mock API from attempting to handle data served from the local `legacy_route` fixture as JSON. Since no `response` object is specified, our mock API will default to serving a fixture from `${fixturesPath}/legacy_route.json`.

N.B.: Under the hood, the `headers` object is passed to Express's `response.set()` method. That means you can specify any HTTP header key/value pairs you'd like here, not just `'Content-Type'`.

### Serving a JSON response with dynamic query params
```js
overrides: {
  get: [
    {
      route: '/api/search',
      withQueryParams: { query: 'foo' },
      response: {
        keyword: 'foo',
        result_count: 15
      },
      status: 200
    }
  ]
}
```
This serves the specified response _only_ when the query string matches the params specified in the `withQueryParams` object; in all other cases, it defers to the default response.

## JS as JSON Responses

Highwind recognizes when a fixture file ends in `.js` instead of `.json`. When this is the case, Highwind evaluates the `export default` function of that file and attempts to return its output as JSON.

This can be useful for creating many fixtures based off of a few base fixtures without the hassle of copying and maintaining 100s of lines of identical JSON in each fixture file.

```
export default () => {
  // Import a complex JSON fixture as a JS object
  const baseJSON = JSON.parse(fs.readFileSync('./fixtures/persisted_json_route.json'));

  // Modify a few values
  baseJSON.title = "I am overriding the title value";

  // Return the modified JS object back to Highwind for parsing back into JSON
  return baseJSON;
}
```

## JSONP and the Callback Query

Highwind serves all routes with `callback` specified in the query string as
JSONP, not JSON, by default.

You can disable this by specifying a non-JS `'Content-Type'` header in an
override for a specific route or by adding  something like
`/callback\=([^\&]+)/` to your `queryStringIgnore` collection.

## License
[MIT License](http://mit-license.org/) © Refinery29, Inc. 2016-2018
