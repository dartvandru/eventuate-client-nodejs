import 'babel-polyfill';
import util from 'util';
import Rx from 'rx';
import Agent, { HttpsAgent } from 'agentkeepalive';
import url from 'url';
import uuid from 'uuid';
import http from 'http';
import https from 'https';
import path from 'path';
import invariant from 'invariant';

import Stomp from './stomp/Stomp';
import AckOrderTracker from './stomp/AckOrderTracker';
import specialChars from './specialChars';
import EsServerError from './EsServerError';

const ackOrderTracker = new AckOrderTracker();

export default class EsClient {

  constructor({ apiKey, spaceName, httpKeepAlive, debug }) {

    this.url =  process.env.EVENTUATE_URL || process.env.EVENT_STORE_URL || 'https://api.eventuate.io';
    this.stompHost = process.env.EVENTUATE_STOMP_SERVER_HOST || process.env.EVENT_STORE_STOMP_SERVER_HOST || 'api.eventuate.io';
    this.stompPort = process.env.EVENTUATE_STOMP_SERVER_PORT || process.env.EVENT_STORE_STOMP_SERVER_PORT || 61614;

    this.apiKey = apiKey;
    this.spaceName = spaceName || false;

    this.urlObj = url.parse(this.url);

    this.determineIfSecure();
    this.setupHttpClient();
    this.setupKeepAliveAgent(httpKeepAlive);

    this.baseUrlPath = '/entity';
    this.debug = debug;


    this.subscriptions = {};
    this.receipts = {};

    this.reconnectInterval = 500;
    this.reconnectIntervalStart = 500;

    this.stompClient = null;

    this.connectionCount = 0;
    this._connPromise = null;
  }

  determineIfSecure() {
    this.useHttps = (this.urlObj.protocol == 'https:');
  }

  setupHttpClient() {
    if (this.useHttps) {
      this.httpClient = https;
    } else {
      this.httpClient = http;
    }
  }

  setupKeepAliveAgent(httpKeepAlive) {

    if (typeof httpKeepAlive === 'undefined') {
      this.httpKeepAlive = true;
    } else {
      this.httpKeepAlive = parseIsTrue(httpKeepAlive);
    }

    if (this.httpKeepAlive ) {

      const keepAliveOptions = {
        maxSockets: 100,
        maxFreeSockets: 10,
        keepAlive: true,
        keepAliveMsecs: 60000 // keep-alive for 60 seconds
      };

      if (this.useHttps) {
        this.keepAliveAgent = new HttpsAgent(keepAliveOptions);
      } else {
        this.keepAliveAgent = new Agent(keepAliveOptions);
      }

    }
  }


  create(entityTypeName, _events, options, callback) {

    callback = callback || options;

    //check input params
    if(!entityTypeName || !_checkEvents(_events)) {
      return callback(new Error('Incorrect input parameters'));
    }

    const events = _prepareEvents(_events);
    const jsonData = {
      entityTypeName,
      events
    };

    addBodyOptions(jsonData, options);

    const urlPath = this.urlSpaceName(this.baseUrlPath);

    return _request(urlPath, 'POST', this.apiKey, jsonData, this, (err, httpResponse, body) => {

      if (err) {
        return callback(err);
      }

      if (httpResponse.statusCode != 200) {
        const error = new EsServerError({
          error: `Server returned status code ${httpResponse.statusCode}`,
          statusCode: httpResponse.statusCode,
          message: body
        });

        return callback(error);
      }

      _toJSON(body, (err, jsonBody) => {

        if (err) {
          return callback(err);
        }

        const { entityId, entityVersion, eventIds} = jsonBody;

        if (!entityId || !entityVersion || !eventIds) {
          return callback(new EsServerError({
            error: 'Bad server response',
            statusCode: httpResponse.statusCode,
            message: body
          }));
        }

        callback(null, {
          entityIdTypeAndVersion: { entityId, entityVersion },
          eventIds
        });
      });
    });
  }

  loadEvents(entityTypeName, entityId, options, callback) {

    callback = callback || options;

    //check input params
    if (!entityTypeName || !entityId) {
      return callback(new Error('Incorrect input parameters'));
    }

    let urlPath = this.urlSpaceName(path.join(this.baseUrlPath, '/', entityTypeName, '/', entityId));

    if (typeof  options == 'object') {
      urlPath += '?' + serialiseObject(options);
    }

    _request(urlPath, 'GET', this.apiKey, null, this, (err, httpResponse, body) => {

      if (err) {
        return callback(err);
      }

      if (httpResponse.statusCode != 200) {
        const error = new EsServerError({
          error: `Server returned status code ${httpResponse.statusCode}`,
          statusCode: httpResponse.statusCode,
          message: body
        });

        return callback(error);
      }

      _toJSON(body, (err, jsonBody) => {

        if (err) {
          return callback(err);
        }

        const events = _eventDataToObject(jsonBody.events);
        callback(null, events);

      });

    });
  }

  update(entityTypeName, entityId, entityVersion, _events, options, callback) {

    callback = callback || options;

    //check input params
    if (!entityTypeName || !entityId || !entityVersion || !_checkEvents(_events)) {
      return callback(new Error('Incorrect input parameters'));
    }

    const events = _prepareEvents(_events);
    const jsonData = {
      entityId,
      entityVersion,
      events
    };

    addBodyOptions(jsonData, options);

    const urlPath = this.urlSpaceName(path.join(this.baseUrlPath, '/', entityTypeName, '/', entityId));

    _request(urlPath, 'POST', this.apiKey, jsonData, this, (err, httpResponse, body) => {

      if (err) {
        return callback(err);
      }

      if (httpResponse.statusCode != 200) {
        const error = new EsServerError({
          error: `Server returned status code ${httpResponse.statusCode}`,
          statusCode: httpResponse.statusCode,
          message: body
        });

        return callback(error);
      }

      _toJSON(body, (err, jsonBody) => {
        if (err) {
          return callback(err);
        }

        const { entityId, entityVersion, eventIds} = jsonBody;

        if (!entityId || !entityVersion || !eventIds) {
          return callback(new EsServerError({
            error: 'Bad server response',
            statusCode: httpResponse.statusCode,
            message: body
          }));
        }

        callback(null, {
          entityIdTypeAndVersion: { entityId, entityVersion },
          eventIds
        });
      });
    });
  }

  getObservableCreateFn(subscriberId, entityTypesAndEvents, callback) {

    return observer => {

      const messageCallback = (body, headers) => {

        ackOrderTracker.add(headers.ack);

        body.forEach(eventStr => {

          const result = this.makeEvent(eventStr, headers.ack);

          if (result.error) {
            return observer.onError(result.error);
          }

          observer.onNext(result.event);
        });
      };

      this.addSubscription(subscriberId, entityTypesAndEvents, messageCallback, callback);

      this.connectToStompServer().then(
        () => {
          this.doClientSubscribe(subscriberId);
        },
        callback
      );
    };
  }

  subscribe(subscriberId, entityTypesAndEvents, callback) {

    if (!subscriberId || !Object.keys(entityTypesAndEvents).length) {
      return callback(new Error('Incorrect input parameters'));
    }

    const createFn = this.getObservableCreateFn(subscriberId, entityTypesAndEvents, callback);

    const observable = Rx.Observable.create(createFn);

    const acknowledge = ack => {
      ackOrderTracker.ack(ack).forEach(this.stompClient.ack.bind(this.stompClient));
    };

    return {
      acknowledge,
      observable
    };
  }

  disconnect() {
    this.closed = true;

    invariant(this._connPromise, 'Disconnect without connection promise spotted.');

    this._connPromise.then(conn => {
      conn.disconnect();
      if (this.stompClient) {
        try {
          this.stompClient.disconnect();
        } catch (e) {
          console.error(e);
        }
      }
    });
  };

  connectToStompServer() {

    return this._connPromise || (this._connPromise = new Promise((resolve, reject) => {

        // Do not reconnect if self-invoked
        if (this.closed) {
          return reject();
        }

        const { stompPort: port, stompHost: host, useHttps: ssl, debug } = this;
        const { id: login, secret: passcode } = this.apiKey;
        const heartBeat = [5000, 5000];
        const timeout = 50000;
        const keepAlive = false;

        invariant(port && host && login && passcode && heartBeat && timeout, 'Incorrect STOMP connection parameters');
        const stompArgs = { port, host, login, passcode, heartBeat, timeout, keepAlive, ssl, debug };

        this.stompClient = new Stomp(stompArgs);
        this.stompClient.connect();

        this.stompClient.on('socketConnected', () => {

          //reset interval
          this.reconnectInterval = this.reconnectIntervalStart;
        });

        this.stompClient.on('connected', () => {

          resolve();
          this.connectionCount++;
        });

        this.stompClient.on('disconnected', () => {
          this.stompClient = null;
          this._connPromise = null;

          // Do not reconnect if self-invoked
          if (!this.closed) {

            if (this.reconnectInterval < 16000) {
              this.reconnectInterval = this.reconnectInterval * 2;
            }

            this.reconnectStompServer(this.reconnectInterval);
          }

        });

        this.stompClient.on('message', frame => {

          const headers = frame.headers;
          const body = frame.body;

          const ack = JSON.parse(specialChars.unescape(headers.ack));

          const subscriberId = ack.receiptHandle.subscriberId;

          if (this.subscriptions.hasOwnProperty(subscriberId)) {
            //call message callback;
            this.subscriptions[subscriberId].messageCallback( body, headers);
          } else {
            console.error(`Can't find massageCallback for subscriber: ${subscriberId}`);
          }
        });

        this.stompClient.on('receipt', receiptId => {
          //Run the callback function
          if (this.receipts.hasOwnProperty(receiptId)) {
            //call Client.subscribe callback;
            this.receipts[receiptId].clientSubscribeCallback(null, receiptId);
          }
        });

        this.stompClient.on('error', error => {
          console.error('stompClient ERROR');
          console.error(error);
        });

      }));
  }

  reconnectStompServer(interval) {
    console.log('\nReconnecting...');
    console.log(interval);

    setTimeout(() => {

      this.connectToStompServer()
        .then(() => {

          //resubscribe
          for (let subscriberId in this.subscriptions) {
            if (this.subscriptions.hasOwnProperty(subscriberId)) {
              this.doClientSubscribe(subscriberId);
            }

          }
        },
        error => {

          //run subscription callback
          for (let receipt in this.receipts) {
            if (this.receipts.hasOwnProperty(receipt)) {
              this.receipts[receipt].clientSubscribeCallback(error);
            }
          }

        }
      );
    }, interval);

  };

  addSubscription(subscriberId, entityTypesAndEvents, messageCallback, clientSubscribeCallback) {

    //add new subscription if not exists
    if (typeof this.subscriptions[subscriberId] == 'undefined') {
      this.subscriptions[subscriberId] = {};
    }

    const destinationObj = {
      entityTypesAndEvents,
      subscriberId
    };

    if (this.spaceName) {
      destinationObj.space = this.spaceName;
    }

    const destination = specialChars.escape(JSON.stringify(destinationObj));

    const uniqueId = uuid.v1().replace(new RegExp('-', 'g'), '');
    const id = `subscription-id-${uniqueId}`;
    const receipt = `receipt-id-${uniqueId}`;

    //add to receipts
    this.addReceipt(receipt, clientSubscribeCallback);

    this.subscriptions[subscriberId] = {
      subscriberId,
      entityTypesAndEvents,
      messageCallback,
      headers: {
        id,
        receipt,
        destination
      }
    };
  };

  addReceipt(receipt, clientSubscribeCallback) {

    let receiptObj = this.receipts[receipt];

    if (typeof receiptObj == 'undefined') {
      receiptObj = {};
    }

    receiptObj.clientSubscribeCallback = clientSubscribeCallback;
  };

  doClientSubscribe(subscriberId) {

    if (!this.subscriptions.hasOwnProperty(subscriberId)) {
      return console.error(new Error(`Can't find subscription for subscriber ${subscriberId}`));
    }

    const subscription = this.subscriptions[subscriberId];

    this.stompClient.subscribe(subscription.headers);
  };

  makeEvent(eventStr, ack) {

    try {

      const {id: eventId, eventType, entityId, eventData: eventDataStr } = JSON.parse(eventStr);

      try {

        let eventData = JSON.parse(eventDataStr);

        const event = {
          eventId,
          eventType,
          entityId,
          ack,
          eventData
        };

        return { event };
      } catch (error) {
        return { error };
      }
    } catch (error) {
      return { error };
    }

  };

  urlSpaceName(urlPath) {

    if (this.spaceName) {
      return urlPath.replace(new RegExp('^' + this.baseUrlPath.replace('/', '\/')), `${this.baseUrlPath}/${this.spaceName}`);
    } else {
      return urlPath;
    }
  }
}

function _eventDataToObject(events) {

  return events.map(e => {

    const event = Object.assign({}, e);

    if (typeof event.eventData != 'string') {
      return event;
    }

    try {
      event.eventData = JSON.parse(event.eventData);
    } catch (err) {
      console.error('Can not parse eventData');
      console.error(err);
      event.eventData = {};
    }

    return event;
  });
}

/**
 * Checks that events have all needed properties
 * Checks eventData
 * @param {Object[]} events - Events
 * @param {string} events[].eventType - The type of event
 * @param {string|Object} events[].eventData - The event data
 * @returns {Boolean}
 */
//TODO: write test
function _checkEvents (events) {

  if (!Array.isArray(events) || !events.length) {
    return false;
  }

  return events.every(({ eventType, eventData }) => {

    if (!eventType || !eventData) {
      return false;
    }

    if (typeof eventData != 'object') {
      try {
        JSON.parse(eventData);
      } catch(e) {
        return false;
      }
    }

    if (Object.keys(eventData).length === 0 ) {
      return false;
    }

    return true;

  });
}

function parseIsTrue(val) {
  return /^(?:t(?:rue)?|yes?|1+)$/i.test(val);
}

//TODO: write test
function serialiseObject(obj) {

  return Object.keys(obj)
    .map(key => {
      return `${key}=${obj[key]}`;
    })
    .join('&');
}

//TODO: write test
function addBodyOptions (jsonData, options) {

  Object.keys(options).reduce((jsonData, key) => {
    return jsonData[key] = options[key];
  }, jsonData);
}

function _prepareEvents(events) {

  return events.map(({ eventData, ...rest } = event) => {

    if (typeof eventData == 'object') {
      eventData = JSON.stringify(eventData);
    }

    return {
      ...rest,
      eventData
    };
  });
}

function _toJSON(variable, callback) {

  if (typeof (variable) == 'object') {

    callback(null, variable);

  } else {

    try {
      callback(null, JSON.parse(variable));
    } catch (err) {
      callback(err);
    }

  }
}

function _request(path, method, apiKey, jsonData, client, callback) {

  const auth = `Basic ${new Buffer(`${apiKey.id}:${apiKey.secret}`).toString('base64')}`;

  const headers = {
    'Authorization' : auth
  };

  let postData;
  if (method == 'POST') {
    postData = JSON.stringify(jsonData);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(postData, 'utf8');
  }

  const options = {
    host: client.urlObj.hostname,
    port: client.urlObj.port,
    path,
    method,
    headers
  };

  if (client.httpKeepAlive) {
    options.agent = client.keepAliveAgent;
  }


  //console.log('request options:', options);

  const req = client.httpClient.request(options, res => {

    res.setEncoding('utf8');

    let responseData = '';

    res.on('data', chunk => {

      responseData += chunk;
    });

    res.on('end', () => {
      callback(null, res, responseData);
    })


  });

  req.on('error', err => {
    callback(err);
  });

  if (method == 'POST') {
    req.write(postData);
  }

  req.end();

  return req;
}