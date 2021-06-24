/*
 * Copyright (c) AXA Group Operations Spain S.A.
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { compareWildcards } from './helper';
import DefaultCompiler from './default-compiler';
import type { ICompiler, IContext } from './default-compiler';
import logger from './logger';

interface IBaseItem {
  applySettings?(args: unknown): void;
}

interface IFactoryItem<T extends IBaseItem = IBaseItem> {
  name: string;
  isSingleton: boolean;
  instance: T;
}

interface IBaseClass extends Record<string, unknown> {
  fromJSON?(obs: Record<string, unknown>): void;
}

type ClassesType = Record<string, new (...args: any[]) => IBaseClass>;
type FactoryType = Record<string, IFactoryItem>;
type PipelinesType = Record<string, never>;
type ConfigurationsType = Record<string, never>;
type CompilersType = Record<string, ICompiler>;
interface ICompilers extends Record<string, ICompiler> {
  default: DefaultCompiler
}
type CacheBestKeysType = Record<string, string | null>;
type CachePipelinesType = Record<string, never>;

/**
 * Container class
 */
export class Container<Classes extends ClassesType = ClassesType, Factory extends FactoryType = FactoryType, Pipelines extends PipelinesType = PipelinesType, Configurations extends ConfigurationsType = ConfigurationsType, Compilers extends ICompilers = ICompilers, CacheBestKeys extends CacheBestKeysType = CacheBestKeysType, CachePipelines extends CachePipelinesType = CachePipelinesType> {
  classes: Classes;
  factory: Factory;
  pipelines: Pipelines;
  configurations: Configurations;
  compilers: Compilers;
  cache: {
    bestKeys: CacheBestKeys;
    pipelines: CachePipelines;
  };
  parent?: Container;
  /**
   * Constructor of the class.
   */
  constructor(hasPreffix = false) {
    this.classes = {} as Classes;
    this.factory = {} as Factory;
    this.pipelines = {} as Pipelines;
    this.configurations = {} as Configurations;
    this.compilers = {} as Compilers;
    this.cache = {
      bestKeys: {} as CacheBestKeys,
      pipelines: {} as CachePipelines,
    };
    this.registerCompiler(DefaultCompiler as new (container: Container) => Compilers[keyof Compilers]);
    if (!hasPreffix) {
      this.use(logger);
    }
  }

  registerCompiler<T extends keyof Compilers>(Compiler: new (container: Container) => Compilers[T], name?: T): void {
    const instance = new Compiler(this);
    this.compilers[name || instance.name as T] = instance;
  }

  addClass<T extends keyof Classes>(clazz: Classes[T], name?: T): void {
    this.classes[name || clazz.name as T] = clazz;
  }

  toJSON<T extends Record<string, unknown>, U extends { toJSON?(): T }>(instance: U): Record<string, unknown> {
    const result = (instance.toJSON ? instance.toJSON() : { ...instance }) as Record<string, unknown>;
    result.className = instance.constructor.name;
    return result;
  }

  fromJSON<T extends keyof Classes, U extends { className: T }>(obj: U, settings: ConstructorParameters<Classes[T]>): InstanceType<Classes[T]> {
    const Clazz = this.classes[obj.className];
    let instance: InstanceType<Classes[T]>;
    if (Clazz) {
      instance = new Clazz(settings) as InstanceType<Classes[T]>;
      if (instance.fromJSON) {
        instance.fromJSON(obj);
      } else {
        Object.assign(instance, obj);
      }
    } else {
      instance = { ...obj } as InstanceType<Classes[T]>;
    }
    delete instance.className;
    return instance;
  }

  register<T extends keyof Factory>(name: T, Clazz: unknown, isSingleton = true): void {
    this.cache.bestKeys = {} as CacheBestKeys;
    const isClass = typeof Clazz === 'function';
    const item = { name, isSingleton } as unknown as Factory[T];
    if (isSingleton) {
      item.instance = isClass ? new (Clazz as new () => unknown)() : Clazz;
    } else {
      item.instance = isClass ? Clazz : Clazz.constructor;
    }
    this.factory[name] = item;
  }

  getBestKey<T extends keyof CacheBestKeys>(name: T): string | undefined {
    if (this.cache.bestKeys[name] !== undefined) {
      return this.cache.bestKeys[name];
    }
    const keys = Object.keys(this.factory) as CacheBestKeys[T][];
    for (let i = 0; i < keys.length; i += 1) {
      if (compareWildcards(name as string, keys[i])) {
        this.cache.bestKeys[name] = keys[i];
        return keys[i];
      }
    }
    this.cache.bestKeys[name] = null;
    return undefined;
  }

  get(name: string, settings?: unknown) {
    let item = this.factory[name];
    if (!item) {
      if (this.parent) {
        return this.parent.get(name, settings);
      }
      const key = this.getBestKey(name);
      if (key) {
        item = this.factory[key];
      }
      if (!item) {
        return undefined;
      }
    }
    if (item.isSingleton) {
      if (item.instance && item.instance.applySettings) {
        item.instance.applySettings(item.instance.settings, settings);
      }
      return item.instance;
    }
    const Clazz = item.instance;
    return new Clazz(settings, this);
  }

  buildLiteral(subtype, step, value, context) {
    return {
      type: 'literal',
      subtype,
      src: step,
      value,
      context,
      container: this,
    };
  }

  resolvePathWithType(step: string, context: IContext, input, srcObject) {
    const tokens = step.split('.');
    let token = tokens[0].trim();
    if (!token) {
      token = step.startsWith('.') ? 'this' : 'context';
    }
    const isnum = /^\d+$/.test(token);
    if (isnum) {
      return this.buildLiteral('number', step, parseFloat(token), context);
    }
    if (token.startsWith('"')) {
      return this.buildLiteral(
        'string',
        step,
        token.replace(/^"(.+(?="$))"$/, '$1'),
        context
      );
    }
    if (token.startsWith("'")) {
      return this.buildLiteral(
        'string',
        step,
        token.replace(/^'(.+(?='$))'$/, '$1'),
        context
      );
    }
    if (token === 'true') {
      return this.buildLiteral('boolean', step, true, context);
    }
    if (token === 'false') {
      return this.buildLiteral('boolean', step, false, context);
    }
    let currentObject: unknown = context;
    if (token === 'input' || token === 'output') {
      currentObject = input;
    } else if (token && token !== 'context' && token !== 'this') {
      currentObject = this.get(token) || currentObject[token];
    } else if (token === 'this') {
      currentObject = srcObject;
    }
    for (let i = 1; i < tokens.length; i += 1) {
      const currentToken = tokens[i];
      if (!currentObject || !currentObject[currentToken]) {
        if (i < tokens.length - 1) {
          throw Error(`Path not found in pipeline "${step}"`);
        }
      }
      const prevCurrentObject = currentObject;
      currentObject = currentObject[currentToken];
      if (typeof currentObject === 'function') {
        currentObject = currentObject.bind(prevCurrentObject);
      }
    }
    if (typeof currentObject === 'function') {
      return {
        type: 'function',
        src: step,
        value: currentObject,
        context,
        container: this,
      };
    }
    return {
      type: 'reference',
      src: step,
      value: currentObject,
      context,
      container: this,
    };
  }

  resolvePath(step: string, context: IContext, input, srcObject) {
    const result = this.resolvePathWithType(step, context, input, srcObject);
    return result ? result.value : result;
  }

  setValue(path: string, valuePath: string, context: IContext, input, srcObject) {
    const value = this.resolvePath(valuePath, context, input, srcObject);
    const tokens = path.split('.');
    const newPath = tokens.slice(0, -1).join('.');
    const currentObject = this.resolvePath(newPath, context, input, srcObject);
    currentObject[tokens[tokens.length - 1]] = value;
  }

  incValue(path: string, valuePath: string, context: IContext, input, srcObject) {
    const value = this.resolvePath(valuePath, context, input, srcObject);
    const tokens = path.split('.');
    if (path.startsWith('.')) {
      tokens.push('this');
    }
    const newPath = tokens.slice(0, -1).join('.');
    const currentObject = this.resolvePath(newPath, context, input, srcObject);
    currentObject[tokens[tokens.length - 1]] += value;
  }

  decValue(path: string, valuePath: string, context: IContext, input, srcObject) {
    const value = this.resolvePath(valuePath, context, input, srcObject);
    const tokens = path.split('.');
    const newPath = tokens.slice(0, -1).join('.');
    const currentObject = this.resolvePath(newPath, context, input, srcObject);
    currentObject[tokens[tokens.length - 1]] -= value;
  }

  eqValue(pathA: string, pathB: string, srcContext: IContext, input, srcObject) {
    const context = srcContext;
    const valueA = this.resolvePath(pathA, context, input, srcObject);
    const valueB = this.resolvePath(pathB, context, input, srcObject);
    context.floating = valueA === valueB;
  }

  neqValue(pathA: string, pathB: string, srcContext: IContext, input, srcObject) {
    const context = srcContext;
    const valueA = this.resolvePath(pathA, context, input, srcObject);
    const valueB = this.resolvePath(pathB, context, input, srcObject);
    context.floating = valueA !== valueB;
  }

  gtValue(pathA: string, pathB: string, srcContext: IContext, input, srcObject) {
    const context = srcContext;
    const valueA = this.resolvePath(pathA, context, input, srcObject);
    const valueB = this.resolvePath(pathB, context, input, srcObject);
    context.floating = valueA > valueB;
  }

  geValue(pathA: string, pathB: string, srcContext: IContext, input, srcObject) {
    const context = srcContext;
    const valueA = this.resolvePath(pathA, context, input, srcObject);
    const valueB = this.resolvePath(pathB, context, input, srcObject);
    context.floating = valueA >= valueB;
  }

  ltValue(pathA: string, pathB: string, srcContext: IContext, input, srcObject) {
    const context = srcContext;
    const valueA = this.resolvePath(pathA, context, input, srcObject);
    const valueB = this.resolvePath(pathB, context, input, srcObject);
    context.floating = valueA < valueB;
  }

  leValue(pathA: string, pathB: string, srcContext: IContext, input, srcObject) {
    const context = srcContext;
    const valueA = this.resolvePath(pathA, context, input, srcObject);
    const valueB = this.resolvePath(pathB, context, input, srcObject);
    context.floating = valueA <= valueB;
  }

  deleteValue(path: string, context: IContext, input, srcObject) {
    const tokens = path.split('.');
    const newPath = tokens.slice(0, -1).join('.');
    const currentObject = this.resolvePath(newPath, context, input, srcObject);
    delete currentObject[tokens[tokens.length - 1]];
  }

  getValue(srcPath: string, context: IContext, input, srcObject) {
    const path = srcPath || 'floating';
    const tokens = path.split('.');
    const newPath = tokens.slice(0, -1).join('.');
    const currentObject = this.resolvePath(newPath, context, input, srcObject);
    return currentObject[tokens[tokens.length - 1]];
  }

  async runPipeline(srcPipeline, input, srcObject, depth = 0) {
    if (depth > 10) {
      throw new Error(
        'Pipeline depth is too high: perhaps you are using recursive pipelines?'
      );
    }
    const pipeline =
      typeof srcPipeline === 'string'
        ? this.getPipeline(srcPipeline)
        : srcPipeline;
    if (!pipeline) {
      throw new Error(`Pipeline not found ${srcPipeline}`);
    }
    if (!pipeline.compiler) {
      const tag = JSON.stringify(pipeline);
      this.registerPipeline(tag, pipeline, false);
      const built = this.getPipeline(tag);
      return built.compiler.execute(built.compiled, input, srcObject, depth);
    }
    return pipeline.compiler.execute(
      pipeline.compiled,
      input,
      srcObject,
      depth
    );
  }

  use(item, name?: string, isSingleton?: boolean, onlyIfNotExists = false) {
    let instance;
    if (typeof item === 'function') {
      if (item.name.endsWith('Compiler')) {
        this.registerCompiler(item);
        return item.name;
      }
      const Clazz = item;
      instance = new Clazz({ container: this });
    } else {
      instance = item;
    }
    if (instance.register) {
      instance.register(this);
    }
    const tag = instance.settings ? instance.settings.tag : undefined;
    const itemName =
      name || instance.name || tag || item.name || instance.constructor.name;
    if (!onlyIfNotExists || !this.get(itemName)) {
      this.register(itemName, instance, isSingleton);
    }
    return itemName;
  }

  getCompiler(name: string): ICompiler {
    const compiler = this.compilers[name];
    if (compiler) {
      return compiler;
    }
    if (this.parent) {
      return this.parent.getCompiler(name);
    }
    return this.compilers.default;
  }

  buildPipeline(srcPipeline: string[], prevPipeline: string[] = []) {
    const pipeline = [];
    if (srcPipeline && srcPipeline.length > 0) {
      for (let i = 0; i < srcPipeline.length; i += 1) {
        const line = srcPipeline[i];
        if (line.trim() === '$super') {
          for (let j = 0; j < prevPipeline.length; j += 1) {
            const s = prevPipeline[j].trim();
            if (!s.startsWith('->')) {
              pipeline.push(prevPipeline[j]);
            }
          }
        } else {
          pipeline.push(line);
        }
      }
    }
    const compilerName =
      !pipeline.length || !pipeline[0].startsWith('// compiler=')
        ? 'default'
        : pipeline[0].slice(12);
    const compiler = this.getCompiler(compilerName);
    const compiled = compiler.compile(pipeline);
    return {
      pipeline,
      compiler,
      compiled,
    };
  }

  registerPipeline(tag: string, pipeline: string[], overwrite = true) {
    if (overwrite || !this.pipelines[tag]) {
      this.cache.pipelines = {};
      const prev = this.getPipeline(tag);
      this.pipelines[tag] = this.buildPipeline(
        pipeline,
        prev ? prev.pipeline : []
      );
    }
  }

  registerPipelineForChilds(childName, tag, pipeline, overwrite = true) {
    if (!this.childPipelines) {
      this.childPipelines = {};
    }
    if (!this.childPipelines[childName]) {
      this.childPipelines[childName] = [];
    }
    this.childPipelines[childName].push({ tag, pipeline, overwrite });
  }

  getPipeline(tag) {
    if (this.pipelines[tag]) {
      return this.pipelines[tag];
    }
    if (this.cache.pipelines[tag] !== undefined) {
      return this.cache.pipelines[tag] || undefined;
    }
    const keys = Object.keys(this.pipelines);
    for (let i = 0; i < keys.length; i += 1) {
      if (compareWildcards(tag, keys[i])) {
        this.cache.pipelines[tag] = this.pipelines[keys[i]];
        return this.pipelines[keys[i]];
      }
    }
    this.cache.pipelines[tag] = null;
    return undefined;
  }

  registerConfiguration(tag, configuration, overwrite = true) {
    if (overwrite || !this.configurations[tag]) {
      this.configurations[tag] = configuration;
    }
  }

  getConfiguration(tag) {
    if (this.configurations[tag]) {
      return this.configurations[tag];
    }
    const keys = Object.keys(this.configurations);
    for (let i = 0; i < keys.length; i += 1) {
      if (compareWildcards(tag, keys[i])) {
        return this.configurations[keys[i]];
      }
    }
    return undefined;
  }

  loadPipelinesFromString(str = '') {
    const lines = str.split(/\n|\r|\r\n/);
    let currentName = '';
    let currentPipeline = [];
    let currentTitle = '';
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line !== '') {
        if (line.startsWith('# ')) {
          if (currentName) {
            if (
              currentTitle &&
              !['default', 'pipelines'].includes(currentTitle.toLowerCase())
            ) {
              this.registerPipelineForChilds(
                currentTitle,
                currentName,
                currentPipeline
              );
            } else {
              this.registerPipeline(currentName, currentPipeline);
            }
          }
          currentTitle = line.slice(1).trim();
          currentName = '';
          currentPipeline = [];
        } else if (line.startsWith('## ')) {
          if (currentName) {
            if (
              currentTitle &&
              !['default', 'pipelines'].includes(currentTitle.toLowerCase())
            ) {
              this.registerPipelineForChilds(
                currentTitle,
                currentName,
                currentPipeline
              );
            } else {
              this.registerPipeline(currentName, currentPipeline);
            }
          }
          currentName = line.slice(2).trim();
          currentPipeline = [];
        } else if (currentName) {
          currentPipeline.push(line);
        }
      }
    }
    if (currentName) {
      if (
        currentTitle &&
        !['default', 'pipelines'].includes(currentTitle.toLowerCase())
      ) {
        this.registerPipelineForChilds(
          currentTitle,
          currentName,
          currentPipeline
        );
      } else {
        this.registerPipeline(currentName, currentPipeline);
      }
    }
  }

  async start(pipelineName = 'main') {
    const keys = Object.keys(this.factory);
    for (let i = 0; i < keys.length; i += 1) {
      const current = this.factory[keys[i]];
      if (current.isSingleton && current.instance && current.instance.start) {
        await current.instance.start();
      }
    }
    if (this.getPipeline(pipelineName)) {
      await this.runPipeline(pipelineName, {}, this);
    }
  }
}

export const defaultContainer = new Container();
