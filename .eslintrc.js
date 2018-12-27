module.exports = {

  root: true,

  extends: "eslint:recommended",

  parser: "babel-eslint",

  env: {
    es6: true,
    node: true
  },

  rules: {
    "no-bitwise": 2,
    "curly": 2,
    "eqeqeq": 1,
    "guard-for-in": 2,
    "wrap-iife": [2, "inside"],
    "indent": [2, 2, { SwitchCase: 1 }],
    "no-use-before-define": [2, "nofunc"],
    "new-cap": 2,
    "no-caller": 2,
    "no-empty": 2,
    "no-undefined": 2,
    "no-unused-vars": 2,
    "space-before-function-paren": [2, "never"],
    "space-after-keywords": 2,
    "no-console": 0
  }
};
