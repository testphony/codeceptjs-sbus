
const requireg = require('requireg');
const { cropLongData } = require('@kronoslive/codeceptjs-utils');
const path = require('path');

const codeceptjsPath = path.resolve(global.codecept_dir, './node_modules/codeceptjs');
// eslint-disable-next-line import/no-dynamic-require
const { recorder } = require(codeceptjsPath);

let Sbus;
let RabbitMqTransport;

let mochawesome;
let utils;

class Rabbit extends Helper {
  constructor(config) {
    super(config);
    // eslint-disable-next-line prefer-destructuring
    Sbus = requireg('sbus-node').Sbus;
    // eslint-disable-next-line prefer-destructuring
    RabbitMqTransport = requireg('sbus-node').RabbitMqTransport;
    this._validateConfig(config);
  }

  _validateConfig(config) {
    this.options = {
      defaultTimeout: 5000,
      defaultCommandRetries: 0,
      prefetchCount: 100,
      exchange: 'common',
      port: '5672',
      autoinit: false,
      channelClosingCallback: err => recorder.throw(err),
      channelReplyErrorCallback: err => recorder.catch(() => {
        throw err;
      }),
    };

    this.receivedMessages = {};

    // override defaults with config
    Object.assign(this.options, config);

    if (!this.options.enabled) {
      return;
    }

    if (!this.options.host) {
      throw new Error(`
        Rabbit requires at hostname to be set.
        Check your codeceptjs config file to ensure this is set properly
          {
            "helpers": {
              "rabbit": {
                "host": "YOUR_HOSTNAME"
              }
            }
          }
        `);
    }
  }

  // eslint-disable-next-line consistent-return
  static _checkRequirements() {
    try {
      requireg('sbus-node');
    } catch (e) {
      return ['sbus-node'];
    }
    // eslint-disable-next-line consistent-return
  }

  _beforeSuite(test, mochawesomeHelper) {
    if (!this.options.enabled) {
      return true;
    }

    mochawesome = mochawesomeHelper || this.helpers.Mochawesome;

    this.options.log = (msg) => {
      mochawesome.addMochawesomeContext({
        title: 'Get Rabbit response',
        value: cropLongData(msg),
      });
    };

    this.transport = new RabbitMqTransport(this.options);
    this.sbus = new Sbus(this.transport);


    utils = this.helpers.Utils;
    if (this.transport.isRunning) {
      return true;
    }

    // Устанавливаем коннект к Rabbit
    return this.transport._connect();
  }

  sendRabbitRequest(routingKey, data, ctx) {
    mochawesome.addMochawesomeContext({
      title: 'Send Rabbit request',
      value: {
        routingKey,
        body: data,
      },
    });

    return this.sbus.request(routingKey, data, ctx);
  }

  sendRabbitCommand(routingKey, data, ctx = {}) {
    mochawesome.addMochawesomeContext({
      title: 'Send Rabbit command',
      value: {
        routingKey,
        body: data,
      },
    });

    return this.sbus.command(routingKey, data, ctx);
  }

  subscribeToRabbitQueue(routingKey, callback = (() => ({})), options = { logging: true }) {
    this.receivedMessages[routingKey] = this.receivedMessages[routingKey] || [];

    const storingCallback = (msg, ctx) => {
      if (options.logging) {
        mochawesome.addMochawesomeContext({
          title: 'Received Rabbit command',
          value: {
            routingKey,
            body: msg,
          },
        });
      }

      this.receivedMessages[routingKey].push(msg);

      return callback(msg, ctx);
    };
    return this.sbus.on(routingKey, storingCallback);
  }

  waitRabbitRequestUntil(routingKey, command, predicate) {
    return utils.waitUntil(() => this.sendRabbitRequest(routingKey, command).then(predicate), 2000, `sbus timeout wait ${routingKey} with ${predicate}`, 250);
  }

  expectRabbitMessageUntil(routingKey, predicate, timeout) {
    if (this.receivedMessages[routingKey] === undefined) {
      throw new Error(`We should subscribe to ${routingKey} before expecting something!`);
    }

    const seen = {};
    let predicateErr;

    return utils.waitUntil(() => Promise.resolve((this.receivedMessages[routingKey] || [])
      .find((msg, i) => {
        try {
          if (!seen[i]) {
            seen[i] = true;
            return predicate(msg);
          }
          return false;
        } catch (err) {
          predicateErr = err;
          return true;
        }
      })), timeout, 'timeout', 100)
      .then(() => {
        if (predicateErr) {
          throw new Error(`predicate return err (${predicateErr.code}), but it should return boolean value`);
        }
        mochawesome.addMochawesomeContext({
          title: `Wait message with predicate for routing key  ${routingKey}`,
          value: predicate.toString(),
        });
        mochawesome.addMochawesomeContext({
          title: 'Latest message',
          value: cropLongData(this.receivedMessages[routingKey][this.receivedMessages[routingKey].length - 1]),
        });
      }).catch((err) => {
        mochawesome.addMochawesomeContext({
          title: `Wait message with predicate for routing key ${routingKey}`,
          value: predicate.toString(),
        });
        mochawesome.addMochawesomeContext({
          title: 'Latest message',
          value: cropLongData(this.receivedMessages[routingKey][this.receivedMessages[routingKey].length - 1]),
        });
        if (err.message === 'timeout') {
          throw new Error(`sbus timeout while expecting ${routingKey} with ${predicate}`);
        } else throw err;
      });
  }

  dontExpectRabbitMessageUntil(routingKey, predicate, timeout) {
    if (this.receivedMessages[routingKey] === undefined) {
      throw new Error(`We should subscribe to ${routingKey} before expecting something!`);
    }

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const found = (this.receivedMessages[routingKey] || []).find(predicate);

        if (found !== undefined) {
          reject(new Error(`Found some not expected: ${JSON.stringify(found)}`));
        } else {
          resolve();
        }
      }, timeout);
    });
  }

  _finishTest() {
    if (!this.options.enabled) {
      return true;
    }

    if (!this.transport.isRunning) {
      return true;
    }

    this.transport.isRunning = false;

    return this.transport.closeConnection();
  }

  _failed() {

  }

  _after() {
    return this.transport.closeSubscribedChannels();
  }
}

module.exports = Rabbit;
