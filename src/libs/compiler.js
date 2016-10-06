
import { error } from '../logger';

export function getCWEventHanlderGlobalVariables ({ lambdaName }) {
  return `
    var __dawsonCWEventLambdaWasCold${lambdaName} = true;
    var __dawsonCWEventLambdaWasColdOn${lambdaName} = Date.now();
  `;
}

export function getCWEventHanlderBody ({ lambdaName }) {
  return `
    if (__dawsonCWEventLambdaWasCold${lambdaName}) {
      __dawsonCWEventLambdaWasCold${lambdaName} = false;
      console.log('Warming up on', new Date());
    } else {
      console.log('Lambda first call was on', new Date(__dawsonCWEventLambdaWasColdOn${lambdaName}));
      console.log('Lambda kept warm for', (Date.now() - __dawsonCWEventLambdaWasColdOn${lambdaName}) / 1000, 'seconds');
    }
    if (event.source && event.source === 'aws.events') {
      return callback(null, true);
    }
  `;
}

export const RUNNER_FUNCTION_BODY = `
Promise.resolve()
.then(function () {
  return runner(event, context);
})
.then(function (data) {
  if (event.meta && event.meta.expectedResponseContentType.indexOf('text/html') !== -1) {
    callback(null, { html: data });
  } else if (event.meta && event.meta.expectedResponseContentType.indexOf('application/json') !== -1) {
    callback(null, { response: JSON.stringify(data) });
  } else if (event.meta && event.meta.expectedResponseContentType.indexOf('text/plain') !== -1) {
    callback(null, { response: data });
  } else {
    console.log('WARNING: Unexpected content type (in event.meta), forwarding result as-is (but it probably errors because we expect a response to be wrapped in a response property.');
    callback(null, data);
  }
})
.catch(function (err) {
  return callback(err);
});
`;
const RUNNER_FUNCTION_BODY_UNWRAPPED = `
runner(event, context, callback);
`;
const RUNNER_FUNCTION_BODY_EVENTHANDLER = `
describeOutputs().then(outputsMap => {
  stackOutputs = outputsMap;
  context.templateOutputs = stackOutputs;
  runner(event, context)
  .then(result => callback(null, result))
  .catch(callback);
});
`;

function prepareIndexFile (apis, stackName) {
  const globals = Object.keys(apis).map(name => {
    const apiConfig = apis[name].api || {};
    if (apiConfig.keepWarm === true) {
      return getCWEventHanlderGlobalVariables({ lambdaName: name });
    } else {
      return '';
    }
  });

  const exp = Object.keys(apis).map(name => {
    const apiConfig = apis[name].api || {};
    let body;
    if (apiConfig.noWrap === true) {
      body = RUNNER_FUNCTION_BODY_UNWRAPPED;
    } else {
      if (apiConfig.isEventHandler === true) {
        body = RUNNER_FUNCTION_BODY_EVENTHANDLER;
      } else {
        body = RUNNER_FUNCTION_BODY;
      }
    }
    return `
      module.exports.${name} = function (event, context, callback) {
        ${(apiConfig.keepWarm === true) ? getCWEventHanlderBody({ lambdaName: name }) : ''}
        const runner = require('./api').${name};
        ${body}
      };
    `;
  });

  return `
  // This is the content of index.js
  // which is require-d by lambda
  // which then executes the handler property
  //
  require("babel-polyfill");
  require('babel-register');

  const AWS = require('aws-sdk');
  const cloudformation = new AWS.CloudFormation({});
  const stackName = '${stackName}';
  var stackOutputs = null;

  function describeOutputs() {
      if (!stackOutputs) {
          const params = {
              StackName: stackName,
          };
          return cloudformation.describeStacks(params).promise()
          .then(result => {
              const outputs = result.Stacks[0].Outputs;
              const ret = {};
              outputs.forEach(output => {
                 ret[output.OutputKey] = output.OutputValue; 
              });
              return ret;
          })
          .catch(err => {
              console.error(\`Error describing stack ${stackName}\`, err.message, err.stack);
          });
      } else {
          return Promise.resolve(stackOutputs);
      }
  }

  // global lambda-specific variables (keepwarm etc...):
  ${globals.join('\n\n')}

  // lambdas:
  ${exp.join('\n\n')}
  `;
}

export default function compileCode (apis, stackName) {
  try {
    const str = prepareIndexFile(apis, stackName);
    return Promise.resolve(str);
  } catch (err) {
    error('Compiler error', err);
    return Promise.reject(err);
  }
}

