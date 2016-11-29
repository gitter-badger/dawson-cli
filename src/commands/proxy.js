
// DAWSON local development proxy (preview)
// ========================================
//
// This command will simulate the CloudFront distribution
//
// This feature is preview-quality
//

import assert from 'assert';
import qs from 'querystring';
import { createProxyServer } from 'http-proxy';
import send from 'send';
import { createServer } from 'http';
import { parse } from 'url';
import pathModule from 'path';
import util from 'util';
import { oneLine } from 'common-tags';

import dockerLambda from 'docker-lambda';
import taskCreateBundle from '../libs/createBundle';

import AWS from 'aws-sdk';
const sts = new AWS.STS({});
const iam = new AWS.IAM({});

import { debug, warning, error, success } from '../logger';
import { SETTINGS, API_DEFINITIONS, APP_NAME } from '../config';
import { compare } from '../libs/pathmatch';

import {
  getStackOutputs,
  getStackResources,
  templateStackName
} from '../factories/cf_utils';

import {
  templateLambdaRoleName
} from '../factories/cf_lambda';

function findApi ({ method, pathname }) {
  let found = null;
  Object.keys(API_DEFINITIONS).forEach(name => {
    if (found) return;
    const fn = API_DEFINITIONS[name];
    const def = fn.api;
    if (!def) return;
    if (def.path === false) return;
    if (typeof def.path === 'undefined') return;
    if ((def.method || 'GET') !== method) return;
    const defPath = `/${def.path}`;
    const result = compare(defPath, pathname);
    if (result !== false) {
      debug(`API handler method: ${name}`);
      found = fn;
      found.pathParams = {}; // [paramName]: paramValue };
      const [names, values] = result;
      names.forEach((paramName, paramIndex) => {
        found.pathParams[paramName] = values[paramIndex];
      });
    }
  });
  if (!found) {
    throw new Error(`API not found at path ${pathname}`);
  }
  return found;
}

function getContentType (fn) {
  return fn.api.responseContentType || 'text/html';
}

async function processAPIRequest (req, res, { body, outputs, resources, pathname, querystring }) {
  const stageVariables = {};
  outputs.forEach(output => {
    stageVariables[output.OutputKey] = output.OutputValue;
  });
  try {
    var runner = findApi({ method: req.method, pathname });
  } catch (e) {
    if (e.message.match(/API not found at path/)) {
      const message = `API not found at path '${req.url}'`;
      console.log(message.bold.red);
      res.writeHead(404);
      res.write(message);
      res.end();
      return;
    } else {
      throw e;
    }
  }
  let expectedResponseContentType = runner.api.responseContentType || 'text/html';
  if (runner.api.redirects) {
    expectedResponseContentType = 'text/plain';
  }
  const event = {
    params: {
      path: {
        ...(runner.pathParams || {})
      },
      querystring,
      header: req.headers
    },
    body,
    meta: {
      expectedResponseContentType
    },
    stageVariables
  };
  debug('Event parameter:'.gray.bold, JSON.stringify(event, null, 2).gray);

  const callback = function apiCallback (err, data) {
    const contentType = getContentType(runner);
    if (err) {
      const errorResponse = JSON.parse(err.errorMessage);
      if (errorResponse.unhandled === true) {
        warning('Unhandled Error:'.bold, oneLine`
          Your lambda function returned an invalid error. Error messages must be valid JSON.stringfy-ed strings and
          should contain an httpStatus (int) property. This error will be swallowed and a generic HTTP 500 response will be returned to the client.
          Please refer to the documentation for instruction on how to deliver proper error responses.
        `);
      }
      res.writeHead(errorResponse.httpStatus, {
        'Content-Type': contentType
      });
      if (contentType === 'application/json') {
        res.write(JSON.stringify(errorResponse));
      } else if (contentType === 'text/plain') {
        res.write(errorResponse.response);
      } else if (contentType === 'text/html') {
        res.write(errorResponse.response);
      } else {
        res.write(errorResponse.response);
      }
      res.end();
      return;
    }
    if (runner.api.redirects) {
      const location = data.response.Location;
      res.writeHead(307, {
        'Content-Type': 'text/plain',
        'Location': location
      });
      res.write(`You are being redirected to ${location}`);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    if (!data) {
      error(`Handler returned an empty body`);
    } else {
      if (contentType === 'application/json') {
        res.write(data.response);
      } else if (contentType === 'text/plain') {
        res.write(data.response);
      } else if (contentType === 'text/html') {
        res.write(data.html);
      } else {
        res.write(data.response);
      }
    }
    console.log(` <- END '${runner.name}' (${new Intl.NumberFormat().format(data.length / 1024)} KB)\n`.red.dim);
    res.end();
  };

  console.log(`\n -> START '${runner.name}'`.green.dim);
  const credentials = await assumeRole(resources, runner);

  const doCall = () => {
    try {
      const invokeResult = dockerLambda({
        event,
        taskDir: `${process.cwd()}/.dawson-dist`,
        handler: `daniloindex.${runner.name}`,
        dockerArgs: []
          .concat(['-m', '512M'])
          .concat(['--env', `NODE_ENV=${process.env.NODE_ENV || 'development'}`])
          .concat(['--env', `AWS_ACCESS_KEY_ID=${credentials.AccessKeyId}`])
          .concat(['--env', `AWS_SECRET_ACCESS_KEY=${credentials.SecretAccessKey}`])
          .concat(['--env', `AWS_SESSION_TOKEN=${credentials.SessionToken}`]),
        spawnOptions: {
          stdio: ['pipe', 'pipe', process.stdout]
        }
      });
      callback(null, invokeResult);
    } catch (invokeError) {
      if (!invokeError.stdout) {
        error(`dawson Internal Error`.bold);
        console.dir(invokeError);
        return;
      }
      const parsedError = JSON.parse(invokeError.stdout.toString('utf8'), null, 2);
      error('Lambda terminated with error:\n', util.inspect(parsedError, { depth: 10, color: true }));
      callback(parsedError, null);
    }
  };

  const authorizer = runner.api.authorizer;

  if (!authorizer) {
    doCall();
  } else {
    runAuthorizer({ authorizer, event, stageVariables, req, res, successCallback: doCall });
  }
}

function findRoleName (stackResources, cfLogicalName) {
  let found = null;
  stackResources.forEach(resource => {
    if (resource.LogicalResourceId === cfLogicalName) {
      found = resource.PhysicalResourceId;
    }
  });
  if (!found) {
    throw new Error(`Cannot find an IAM Role for '${cfLogicalName}'`);
  }
  return found;
}

async function assumeRole (stackResources, runner) {
  const functionName = runner.name;
  const lambdaName = functionName[0].toUpperCase() + functionName.substring(1);
  const cfLogicalRoleName = templateLambdaRoleName({ lambdaName });
  const roleName = findRoleName(stackResources, cfLogicalRoleName);
  const getRoleResult = await iam.getRole({
    RoleName: roleName
  }).promise();
  const roleArn = getRoleResult.Role.Arn;
  const assumeRoleParams = {
    RoleArn: roleArn,
    RoleSessionName: 'dawson-dev-proxy'
  };
  const assumedRole = await sts.assumeRole(assumeRoleParams).promise();
  return assumedRole.Credentials;
}

function runAuthorizer ({ authorizer, event, stageVariables, req, res, successCallback }) {
  // https://docs.aws.amazon.com/apigateway/latest/developerguide/use-custom-authorizer.html
  // @TODO: correctly handle 401, 403, 500 response as described in the documentation

  const token = event.params.header.token;
  console.log(` 🔒 Invoking authorizer, token = ${util.inspect(token)}`.yellow.dim);

  const fail = (httpStatusCode = 403, ...logs) => {
    console.error(...logs);
    res.writeHead(httpStatusCode, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify({ message: 'Unauthorized' }));
    res.end();
  };

  if (!token) {
    fail(401, ' 🔒'.red, `No authorization header found. You must specify a 'token' header with your request.`.red);
    return;
  }

  authorizer({
    type: 'TOKEN',
    authorizationToken: token,
    methodArn: 'arn:fake'
  }, {
    templateOutputs: stageVariables,
    succeed: ({ policyDocument }, principalId) => {
      if (!policyDocument || !Array.isArray(policyDocument.Statement)) {
        fail(403, ' 🔒'.red, `Authorizer did not return a policy document`.red, policyDocument);
        return;
      }
      if (!policyDocument.Statement.find(item => item.Effect === 'Allow' && item.Action === 'execute-api:Invoke' && item.Resource === 'arn:fake')) {
        fail(403, ' 🔒'.red, `Authorizer did not return a valid policy document`.red, policyDocument);
        return;
      }
      event.authorizer = {
        principalId
      };
      console.log(` 🔓 Authorization succeeded`.yellow.dim);
      successCallback();
    },
    fail: message => {
      fail(403, ' 🔒'.red, `Authorizer failed with message: '${message}'`.red);
    }
  });
}

function requestForAPI (req) {
  if (SETTINGS.cloudfrontRootOrigin === 'assets') {
    return req.url.startsWith('/prod');
  } else {
    return !req.url.startsWith('/assets');
  }
}

function parseAPIUrl (req) {
  let urlString;
  if (SETTINGS.cloudfrontRootOrigin === 'assets') {
    urlString = req.url.replace('/prod', '');
  } else {
    urlString = req.url;
  }
  const url = parse(urlString);
  return url;
}

function parseAssetsUrlString (req) {
  let urlString;
  if (SETTINGS.cloudfrontRootOrigin !== 'assets') {
    urlString = req.url.replace('/assets', '');
  } else {
    urlString = req.url;
  }
  if (urlString.indexOf('?') !== -1) {
    urlString = urlString.substring(0, urlString.indexOf('?'));
  }
  return urlString;
}

export function run (argv) {
  const {
    stage,
    port,
    proxyAssetsUrl,
    assetsPathname
  } = argv;

  assert(proxyAssetsUrl || assetsPathname, 'You must specify either --proxy-assets-url or --assets-pathname');

  const stackName = templateStackName({ appName: APP_NAME, stage });

  const proxy = createProxyServer({});
  // Proxy errors
  proxy.on('error', err => {
    error(`Proxy request error: ${err.message}`.bold.red);
  });

  const server = createServer((req, res) => {
    debug(` -> ${req.method} ${req.url}`);

    if (req.url === '/favicon.ico') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (requestForAPI(req)) {
      const url = parseAPIUrl(req);
      const pathname = url.pathname;
      const querystring = qs.parse(url.query);
      let rawBody = new Buffer('');
      let jsonBody = {};
      const next = () => {
        Promise.all([
          getStackOutputs({ stackName }),
          getStackResources({ stackName })
        ])
        .catch(err => {
          error('Error describing stack', err);
        })
        .then(([ outputs, resources ]) => {
          processAPIRequest(req, res, {
            pathname,
            querystring,
            body: jsonBody,
            outputs,
            resources
          });
        })
        .catch(err => {
          error('processAPIRequest error', err);
        });
      };
      if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') {
        next();
        return;
      }
      req.on('data', chunk => {
        rawBody = Buffer.concat([rawBody, chunk]);
      });
      req.on('end', () => {
        rawBody = Buffer.concat([rawBody]);
        const rawUTFBody = rawBody.toString('utf8');
        try {
          jsonBody = JSON.parse(rawUTFBody);
        } catch (err) {
          error(`Could not parse JSON request body`.red.bold, rawUTFBody.red);
          jsonBody = {};
        }
        next();
      });
      req.resume();
    } else {
      if (assetsPathname) {
        const path = parseAssetsUrlString(req);
        send(req, path, {
          cacheControl: false,
          root: pathModule.join(process.cwd(), assetsPathname)
        })
        .on('error', error => {
          res.writeHead(error.status || 500);
          const message = `Resource not found in '/assets' at path '${path}'`;
          console.log(message.yellow.bold);
          res.write(message);
          res.end();
        })
        .pipe(res);
      } else {
        proxy.web(req, res, {
          target: proxyAssetsUrl
        });
      }
    }
  });

  server.on('clientError', err => {
    error('Server error', err);
  });

  process.stdout.write('\x1B[2J\x1B[0f');
  taskCreateBundle({
    appStageName: stage,
    noUpload: true,
    stackName
  })
  .run()
  .catch(err => {
    error(`An error occurred while creating your app bundle`);
    error(err);
    process.exit(1);
  })
  .then(() => {
    server.listen(port);
    success(`\nDevelopment proxy listening on http://0.0.0.0:${port}`.bold.green);
  });
}
