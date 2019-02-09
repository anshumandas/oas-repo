'use strict';

const fs = require('fs');
const Path = require('path');

const _ = require('lodash');
const YAML = require('js-yaml');
const glob = require('glob').sync;
const sway = require('sway');
const chalk = require('chalk');
const mkdirp = require('mkdirp').sync;
const requireDir = require('require-dir');

const jpath = require('jsonpath');
const jsonpointer = require('json-pointer');

const express = require('express');
const bodyParser = require('body-parser');

const livereload = require('./livereload');
const betterErrors = require('./better-errors');
const { pathToFilename, anyYaml, dirExist } = require('./utils');

var routes = {};

function calcPaths(basedir = 'spec/') {
  return {
    mainFile: basedir + 'openapi.yaml',
    pathsDir: basedir + 'paths/',
    definitionsDir: basedir + 'definitions/',
    codeSamplesDir: basedir + 'code_samples/',
    componentsDir: basedir + 'components/',
    children: findChildren(basedir) //By Anshuman Das
  };
}

//By Anshuman Das
function findChildren(basedir) {
  if(dirExist(basedir)) {
    const isValidDirectory = source => fs.lstatSync(source).isDirectory() && !(_.endsWith(source, 'paths') || _.endsWith(source, 'components'));
    const getDirectories = source => {
      if(source) {
        return fs.readdirSync(source).map(name => Path.join(source, name)).filter(isValidDirectory);
      }
      return [];
    }
    var dirs = basedir ? getDirectories(basedir) : [];
    return dirs;
  }
  return null;
}

const REDOCLY_CONFIG = 'redocly.yaml';

const OPENAPI3_COMPONENTS = [
  'schemas',
  'responses',
  'parameters',
  'examples',
  'headers',
  'requestBodies',
  'links',
  'callbacks',
  'securitySchemes'
];

exports.readConfig = function() {
  return readYamlOrDefault(
    REDOCLY_CONFIG,
    {},
    `Redocly config not found at ${chalk.yellow(REDOCLY_CONFIG)}. Using empty...`
  );
};

exports.compileIndexPage = function(options = {}) {
  const fileContents = fs.readFileSync('web/index.html', 'utf-8');
  let redocConfig = readYamlOrDefault(
    'web/redoc-config.yaml',
    {},
    `ReDoc config not found in ${chalk.yellow('web/redoc-config.yaml')}. Skipping...`
  );

  const redocURL =
    redocConfig.redocURL || 'https://cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js';
  const redocExport = redocConfig.redocExport || 'Redoc';
  return fileContents
    .replace('{{redocHead}}', options.livereload ? livereload.LIVERELOAD_SCRIPT : '')
    .replace(
      '{{redocBody}}',
      `<div id="redoc_container"></div>
    <script src="${redocURL}"></script>
    <script>
      ${redocExport}.init(
        './openapi.json',
        ${JSON.stringify(redocConfig)},
        document.getElementById("redoc_container")
      );
    </script>`
    );
};

exports.indexMiddleware = function(req, res) {
  try {
    const page = exports.compileIndexPage({ livereload: true });
    res.end(page);
  } catch(e) {
    console.log(chalk.red(e.message));
    res.writeHead(500, {
      'Content-Type': 'text/html; charset=utf-8'
    });
    res.end(`<div style="color: red"><h3> Error </h3><pre>${e.message}</pre></div>`);
  }
};

exports.swaggerEditorMiddleware = function(options = {}) {
  const router = express.Router();

  //Anshuman Das: added children return
  options.router = router;
  const { mainFile, children } = calcPaths(options.basedir);

  // router.use('/config/defaults.json', express.static(require.resolve('./editor_config.json')))
  router.get('/', async (req, res) => {

    let bundled = await exports.bundle({
      skipCodeSamples: true,
      skipHeadersInlining: true,
      skipPlugins: false, //changed by Anshuman Das
      basedir: options.basedir,
      action: 'get' //Anshuman: added action identifier
    });

    //Anshuman: handle the children paths in bundled
    //TODO use children to create the child files
    bundled = _.omit(bundled, 'children');

    let spec;
    if (_.isEqual(bundled, readYaml(mainFile))) {
      spec = fs.readFileSync(mainFile, 'utf-8');
    } else {
      spec =
        '' +
        '# Note: This spec is defined in multiple files.\n' +
        '# All comments and formating were lost during the bundle process.\n' +
        '# Existing files formatting may be not preserved on save.\n' +
        exports.stringify(bundled, { yaml: true });
    }

    const fileContents = fs.readFileSync(Path.join(__dirname, 'editor.html'), 'utf-8');
    res.send(fileContents.replace('<%SPEC_CONTENTS%>', JSON.stringify(spec)));
    res.end();
  });

  router.use('/', express.static(Path.dirname(require.resolve('swagger-editor-dist/index.html'))));

  router.use(
    bodyParser.text({
      type: 'application/yaml',
      limit: '10mb' // default limit was '100kb' which is too small for many specs
    })
  );

  router.put('/backend_openapi.yaml', async function(req, res) {
    try {
      await exports.syncWithSpec(req.body, options);
    } catch (e) {
      console.log(chalk.red('Error while synchronizing spec from Swagger Editor: ' + e.message));
      console.log(e.stack);
    }
    res.end('ok');
    // TODO: error handling
  });

  //By Anshuman Das
  initChildren(children, options, router, exports.swaggerEditorMiddleware);

  return router;
};

//By Anshuman Das start
function initChildren(children, options, router, func) {
  for (var child of children) {
    initChild(child, options, router, func);
  }
}

function initChild(child, options, router, func) {
  var childOptions = _.cloneDeep(options);
  var parent = options.basedir || 'spec/';
  var childPath = '/' + removeParentPath(child, parent);
  childOptions.basedir = child+'/';
  childOptions.path = childPath;
  router.use(childPath, func(childOptions));
}

function removeParentPath(child, parent) {
  return parent ? child.substring(parent.length) : null;
}

//By Anshuman Das end

exports.getPatchedSwaggerUIIndex = function() {
  const orig = fs.readFileSync(require.resolve('swagger-ui-dist/index.html'), 'utf-8');
  return orig.replace('https://petstore.swagger.io/v2/swagger.json', '../openapi.json');
};

exports.swaggerUiMiddleware = function() {
  const router = express.Router();
  router.get('/', function(req, res) {
    res.end(exports.getPatchedSwaggerUIIndex());
  });
  router.use('/', express.static(Path.dirname(require.resolve('swagger-ui-dist'))));
  return router;
};

exports.specMiddleware = function(options = {}) {
  //Anshuman Das: added children return
  const { mainFile, children } = calcPaths(options.basedir);

  //Anshuman: added action identifier
  options.action = 'get';

  const router = express.Router();

  routes[options.path || '/'] = router;

  router.get('/openapi.json', async function(req, res) {
    let bundled = await exports.bundle(options);
    //Anshuman: handle the children paths in bundled
    bundled = _.omit(bundled, 'children');
    res.setHeader('Content-Type', 'application/json');
    try {
      res.end(exports.stringify(bundled, { json: true }));
    } catch (e) {
      console.log(chalk.red('Error while bundling the spec: ' + e.message));
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.get('/openapi.yaml', async function(req, res) {
    let bundled = await exports.bundle(options);
    //Anshuman: handle the children paths in bundled
    bundled = _.omit(bundled, 'children');
    res.setHeader('Content-Type', 'application/yaml');
    res.end(exports.stringify(bundled, { yaml: true }));
  });

  router.use(express.static('web'));

  //By Anshuman Das
  initChildren(children, options, router, exports.specMiddleware);

  return router;
};

exports.syncWithSpec = async function(spec, options = {}) {
  const { pathsDir, definitionsDir, componentsDir, mainFile, children } = calcPaths(options.basedir);

  if (_.isString(spec)) {
    if (!dirExist(pathsDir) && (!dirExist(definitionsDir) || !dirExist(componentsDir))) {
      // no need to split, just flat file structure
      mkdirp(Path.dirname(mainFile));
      return fs.writeFileSync(mainFile, spec);
    }
    spec = exports.parse(spec);
  }

  //Anshuman : added plugins here
  options.action = 'put';
  if (!options.skipPlugins) {
    //Anshuman: add the existing children paths in bundled
    spec = await addChildren(spec, children, options.basedir);
    await runPlugins(spec, options);
    //Anshuman: handle the children paths in bundled
    if(_.has(spec, 'children')) {
      _.forEach(spec.children, function(child, key){
        let childPath = (options.basedir || 'spec/') + key ;
        let created = generatePartFiles(child, {basedir: childPath + '/'});
        initChild(childPath, options, options.router, exports.swaggerEditorMiddleware);
        var cp = _.startsWith(childPath, 'spec/') ? childPath.substring(4) : childPath;
        var ppath = cp.substring(0, cp.lastIndexOf('/'));
        ppath = ppath.length > 0 ? ppath : '/';
        var p = routes[ppath];
        initChild(childPath, options, p, exports.specMiddleware);
      });
      spec = _.omit(spec, 'children');
    }
  }
  generatePartFiles(spec, options);
}

//By Anshuman start
async function addChildren(spec, children, parent) {
  if(children && parent) {
    spec.children = {};
    for (var child of children) {
      var childName = removeParentPath(child, parent);
      let bundled = await exports.bundle({basedir: child + '/'});
      spec.children[childName.toLowerCase()] = bundled;
    }
  }
  return spec;
}

function generatePartFiles(spec, options) {
  var ret = false;
  const { pathsDir, definitionsDir, componentsDir, mainFile } = calcPaths(options.basedir);
  if(options.basedir && !dirExist(options.basedir)) {
    fs.mkdirSync(options.basedir);
    fs.mkdirSync(pathsDir);
    fs.mkdirSync(componentsDir);
    ret = true;
  }
//By Anshuman end
  if (spec.paths && dirExist(pathsDir)) {
    const paths = _.mapKeys(spec.paths, function(_value, key) {
      return pathToFilename(key);
    });
    updateGlobObject(pathsDir, paths);
    spec = _.omit(spec, 'paths');
  }
  if (spec.openapi) {
    if (spec.components && dirExist(componentsDir)) {
      for (const componentType of OPENAPI3_COMPONENTS) {
        const compDir = Path.join(componentsDir, componentType);
        if (spec.components[componentType]) {
          mkdirp(compDir);
          updateGlobObject(compDir, spec.components[componentType]);
          spec.components = _.omit(spec.components, componentType);
        }
      }
      if (!Object.keys(spec.components).length) {
        spec = _.omit(spec, 'components');
      }
    }
  } else {
    if (spec.definitions && dirExist(definitionsDir)) {
      updateGlobObject(definitionsDir, spec.definitions);
      spec = _.omit(spec, 'definitions');
    }
  }

  updateYaml(mainFile, spec);
  return ret;
};

exports.bundle = async function(options = {}) {
  const { pathsDir, definitionsDir, componentsDir, mainFile, codeSamplesDir } = calcPaths(
    options.basedir
  );
  const spec = readYaml(mainFile);

  if (dirExist(pathsDir)) {
    if (options.verbose) {
      console.log('[spec] Adding paths to spec');
    }
    if (spec.paths) {
      throw Error('All paths should be defined inside ' + pathsDir);
    }
    spec.paths = globYamlObject(pathsDir, _.flow([baseName, filenameToPath]));
  }

  if (spec.openapi) {
    if (dirExist(componentsDir)) {
      if (spec.components) {
        throw Error(`All components should be defined inside ${componentsDir}`);
      }
      spec.components = {};

      for (const componentType of OPENAPI3_COMPONENTS) {
        const compDir = Path.join(componentsDir, componentType);
        if (!dirExist(compDir)) {
          continue;
        }
        if (options.verbose) {
          console.log(`[spec] Adding components/${componentType} to spec`);
        }
        spec.components[componentType] = globYamlObject(compDir, baseName);
      }
    }
  } else {
    if (dirExist(definitionsDir)) {
      if (options.verbose) {
        console.log('[spec] Adding definitions to spec');
      }
      if (spec.definitions) {
        throw Error('All definitions should be defined inside ' + definitionsDir);
      }
      spec.definitions = globYamlObject(definitionsDir, baseName);
    }
  }

  if (!options.skipCodeSamples && dirExist(codeSamplesDir)) {
    if (options.verbose) {
      console.log('[spec] Adding code samples to spec');
    }
    bundleCodeSample(spec, codeSamplesDir);
  }

  if (!options.skipHeadersInlining && spec.headers) {
    if (options.verbose) {
      console.log('[spec] Inlining headers referencess');
    }
    inlineHeaders(spec);
  }

  if (!options.skipPlugins) {
    await runPlugins(spec, options);
  }

  return spec;
};

async function runPlugins(spec, options) {
  const relativePluginsDir = process.env.SWAGERREPO_PLUGINS_DIR || 'spec/plugins';
  const pluginsDir = Path.join(process.cwd(), relativePluginsDir);
  let plugins;

  if (!fs.existsSync(pluginsDir)) {
    return;
  }

  plugins = requireDir(pluginsDir);

  plugins = _.values(plugins);

  for(var plugin of plugins) {
    plugin.init && await plugin.init(spec, options);
    for(var node of jpath.nodes(spec, plugin.pathExpression)) {
      const name = _.last(node.path);
      const parent = jpath.value(spec, jpath.stringify(_.dropRight(node.path)));
      await plugin.process(parent, name, node.path, spec);
    };
    plugin.finish && await plugin.finish(spec);
  };
}

function bundleCodeSample(spec, codeSamplesDir) {
  const codeSamples = globObject(codeSamplesDir, '*/*/*', function(filename) {
    // path === '<language>/<path>/<verb>'
    const dirs = Path.dirname(filename);
    const lang = Path.dirname(dirs);
    const path = Path.basename(dirs);
    // [<path>, <verb>, <language>]
    return [filenameToPath(path), baseName(filename), lang];
  });

  _.each(codeSamples, function(pathSamples, path) {
    _.each(pathSamples, function(opSamples, verb) {
      const operation = _.get(spec.paths, [path, verb]);
      if (_.isUndefined(operation)) {
        throw Error('Code sample for non-existing operation: "' + path + '",' + verb);
      }

      if (_.has(operation, 'x-code-samples')) {
        throw Error('All code samples should be defined inside ' + codeSamplesDir);
      }

      operation['x-code-samples'] = _.map(opSamples, function(path, lang) {
        return { lang: lang, source: fs.readFileSync(path, 'utf-8') };
      });
    });
  });
}

exports.stringify = function(spec, options = {}) {
  if (options.yaml) {
    return YAML.safeDump(spec, { indent: 2, lineWidth: -1, noRefs: true });
  }

  return JSON.stringify(spec, null, 2) + '\n';
};

exports.parse = function(string) {
  try {
    return YAML.safeLoad(string, { json: true });
  } catch (e) {
    throw new Error('Can not parse OpenAPI file ' + e.message);
  }
};

exports.validate = function(spec, options = {}, cb) {
  if (spec.openapi) {
    const validator = require('oas-validator');
    const validateOptions = { prettify: false, lint: false, validateSchema: 'first' };
    let valid = false;
    try {
      valid = validator.validateSync(spec, validateOptions);
    } catch (e) {
      if (e instanceof validator.JSONSchemaError) {
        console.error(chalk.red('Failed OpenAPI3 schema validation:\n'));
        const errors = JSON.parse(e.message.replace(/^.*\[/, '['));
        betterErrors(errors, calcPaths(options.basedir));
      } else {
        console.error(chalk.red(`Lint error:\n`));
        e.keyword = '__lint';
        e.dataPath = validateOptions.context.pop() || '';
        if (e.dataPath.startsWith('#')) {
          e.dataPath =  e.dataPath.substring(1);
        }
        betterErrors([e], calcPaths(options.basedir));
      }
      process.exit(1);
    }
    if (valid) {
      cb(null, {});
    }
    return;
  }

  sway.create({ definition: spec }).then(
    function(specObj) {
      return cb(null, specObj.validate());
    },
    function(error) {
      cb(error);
    }
  );
};

function inlineHeaders(spec) {
  jpath.apply(spec, '$..[?(@.$ref)]', function(value) {
    if (!value.$ref.startsWith('#/headers')) {
      return value;
    }

    // TODO: throw if (!_.omit(value, '$ref').isEmpty())
    return jsonpointer.get(spec, value.$ref.substring(1));
  });
  delete spec.headers;
}

function baseName(path) {
  return Path.parse(path).name;
}

function filenameToPath(filename) {
  return '/' + filename.replace(/@/g, '/');
}

function globObject(dir, pattern, objectPathCb) {
  return _.reduce(
    glob(Path.join(dir, pattern)),
    function(result, path) {
      const objPath = objectPathCb(path.substring(dir.length));
      if (_.has(result, objPath)) {
        throw new Error(objPath + ' definition already exists');
      }
      _.set(result, objPath, path);

      return result;
    },
    {}
  );
}

function globYamlObject(dir, objectPathCb) {
  return _.mapValues(globObject(dir, anyYaml, objectPathCb), readYaml);
}

function updateGlobObject(dir, object) {
  const knownKeys = globObject(dir, anyYaml, baseName);

  _.each(object, function(value, key) {
    let filename = Path.join(dir, key + '.yaml');
    if (key in knownKeys) {
      filename = knownKeys[key];
      delete knownKeys[key];
    }
    updateYaml(filename, value);
  });

  _(knownKeys)
    .values()
    .each(fs.unlinkSync);
}

function updateYaml(file, newData) {
  let currentData;
  try {
    currentData = readYaml(file, true);
  } catch (e) {
    // nope
  }

  if (!_.isEqual(newData, currentData)) {
    saveYaml(file, newData);
  }
}

function readYaml(file, silent) {
  try {
    return YAML.safeLoad(fs.readFileSync(file, 'utf-8'), { filename: file });
  } catch (e) {
    if (!silent) {
      console.log(chalk.red(e.message));
    }
  }
}

function readYamlOrDefault(fileName, defaultVal, defaultMessage) {
  try {
    return YAML.safeLoad(fs.readFileSync(fileName, 'utf-8'), { filename: fileName });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(defaultMessage);
      return defaultVal;
    } else {
      throw e;
    }
  }
}

function saveYaml(file, object) {
  mkdirp(Path.dirname(file));
  return fs.writeFileSync(file, YAML.safeDump(object, { noRefs: true }));
}
