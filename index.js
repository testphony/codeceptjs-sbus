// eslint-disable-next-line max-classes-per-file
const requireg = require('requireg');
const Helper = require('@codeceptjs/helper');

const { errorFromCode } = require('@copper/model');

// eslint-disable-next-line import/no-dynamic-require

// eslint-disable-next-line no-unused-vars
class NoOpLogger {
  error() {
  }

  debug() {
  }

  info() {
  }

  trace() {
  }
}

class Rabbit extends Helper {
  constructor(config) {
    const defaults = {
      auth: {
        enabled: false,
        required: false,
        publicKeys: {},
        consul: {
          enabled: false,
        },
        rbac: {
          identities: {},
          actions: { '*': { permissions: ['*'] } },
        },
      },
      host: 'localhost',
      username: 'guest',
      password: 'guest',
      port: 5672,
      prefetchCount: 64,
      defaultCommandRetries: 15,
      defaultTimeout: 12000,
      shutdownTimeout: 3000,
      logTrimLength: 2048,
      unloggedRequests: [],
      useSingletonSubscribe: false,
      autoinit: false,
      logger: new NoOpLogger(),
      channels: {
        default: {
          exchange: 'sbus.common',
          exchangeType: 'direct',

          queueName: '%s',
          durable: false,
          exclusive: false,
          autoDelete: false,
          mandatory: true,
          heartbeat: false,
          routingKeys: [], // optional, by default get from subscriptionName
        },
        events: {
          exchange: 'sbus.events',
          exchangeType: 'topic',

          mandatory: false,
          heartbeat: true,
        },
        broadcast: {
          exchange: 'sbus.events',
          exchangeType: 'topic',

          queueName: '',
          exclusive: true,
          autoDelete: true,
          mandatory: false,
          heartbeat: true,
        },
      },
    };

    super({ ...defaults, ...config });
  }

  _validateConfig(config) {
    if (!config.enabled) {
      return;
    }

    if (!config.host) {
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

    // eslint-disable-next-line consistent-return
    return super._validateConfig(config);
  }

  // eslint-disable-next-line consistent-return
  static _checkRequirements() {
    try {
      requireg('@copper/sbus');
    } catch (e) {
      return ['@copper/sbus'];
    }
  }

  // eslint-disable-next-line consistent-return,no-unused-vars
  async _init() {
    if (!this.config.enabled) {
      return true;
    }

    if (this.transport) {
      return true;
    }

    const {
      Sbus,
      RabbitMqTransport,
      ConsulAuthConfigProvider,
      AuthProviderImpl,
      NoopDynamicAuthConfigProvider,
      NoopAuthProvider,
    } = requireg('@copper/sbus');

    const dynamicAuthConfigProvider = this.config.auth.consul.enabled || false
      ? new ConsulAuthConfigProvider(this.config.auth.consul)
      : new NoopDynamicAuthConfigProvider();

    const authProvider = this.config.auth.enabled && this.config.auth.name && this.config.auth.privateKey
      ? new AuthProviderImpl(this.config.auth, this.config.logger, dynamicAuthConfigProvider)
      : new NoopAuthProvider();

    this.transport = new RabbitMqTransport();
    await this.transport.init(this.config, authProvider);

    this.sbus = new Sbus(this.transport, authProvider);

    await this.transport.connect();

    return true;
  }

  // eslint-disable-next-line consistent-return,no-unused-vars
  async _finishTest(suite) {
    if (!this.config.enabled) {
      return true;
    }

    if (!this.transport) {
      return true;
    }

    await this.transport.close();

    this.transport = null;
    this.sbus = null;

    return true;
  }

  // eslint-disable-next-line no-unused-vars
  _before(test) {
    this.receivedMessages = {};
  }

  // eslint-disable-next-line no-unused-vars
  _after(test) {
    this.receivedMessages = {};
  }

  sendRabbitRequest(routingKey, data, ctx = {}, cls = Object) {
    if (!this.sbus) {
      return Promise.resolve();
    }

    return this.sbus.request(routingKey, data, cls, ctx)
      .then((res) => ({
        status: 200,
        body: res,
      }))
      .catch((res) => ({
        ...res,
        status: res.code ? parseInt(res.code, 10) : 500,
      }));
  }

  sendRabbitCommand(routingKey, data, ctx = {}) {
    if (!this.sbus) {
      return Promise.resolve();
    }

    return this.sbus.command(routingKey, data, ctx)
      .then((res) => ({
        status: 200,
        body: res,
      }))
      .catch((res) => ({
        ...res,
        status: res.code ? parseInt(res.code, 10) : 500,
      }));
  }

  sendRabbitEvent(routingKey, data, ctx = {}) {
    if (!this.sbus) {
      return Promise.resolve();
    }

    return this.sbus.event(routingKey, data, ctx)
      .then((res) => ({
        status: 200,
        body: res,
      }))
      .catch((res) => ({
        ...res,
        status: res.code ? parseInt(res.code, 10) : 500,
      }));
  }

  subscribeToRabbitQueue(routingKey, callback = (() => ({})), options = { logging: true }) {
    if (!this.sbus) {
      return Promise.resolve();
    }

    this.receivedMessages[routingKey] = this.receivedMessages[routingKey] || [];

    const ctx = {
      exchange: options.exchange,
    };

    const storingCallback = (msg, ctx) => {
      const payload = {
        routingKey,
        body: msg,
      };

      this.receivedMessages[routingKey].push(payload);

      const resp = callback(payload, ctx);

      if (resp.status < 400) {
        return resp.body;
      }
      throw errorFromCode(resp.status, resp.body);
    };
    return this.sbus.on(routingKey, storingCallback, ctx);
  }

  waitRabbitRequestUntil(routingKey, command, predicate, ctx = {}, cls = Object) {
    return this.helpers.Utils.waitUntil(() => this.sendRabbitRequest(routingKey, command, ctx, cls)
      .then(predicate), 2000, `sbus timeout wait ${routingKey} with ${predicate}`, 250);
  }

  expectRabbitMessageUntil(routingKey, predicate, timeout) {
    if (this.receivedMessages[routingKey] === undefined) {
      throw new Error(`We should subscribe to ${routingKey} before expecting something!`);
    }

    const seen = {};
    let predicateErr;

    return this.helpers.Utils.waitUntil(() => Promise.resolve((this.receivedMessages[routingKey] || [])
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
      })
      .catch((err) => {
        if (err.message === 'timeout') {
          throw new Error(`sbus timeout while expecting ${routingKey} with ${predicate}`);
        } else {
          throw err;
        }
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
}

module.exports = Rabbit;
