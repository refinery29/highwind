import baseJSON from './persisted_json_route.json';

export default () => {
  baseJSON.result.body = "A persisting JS response for unit tests";
  baseJSON.title = "JS to JSON Response";
  return baseJSON;
}
