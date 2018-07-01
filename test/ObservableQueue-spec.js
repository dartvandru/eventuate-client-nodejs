'use strict';
const ObservableQueue = require('../dist/modules/ObservableQueue');
const helpers = require('./lib/helpers');

const timeout = 10000;

const entityType = 'net.chrisrichardson.eventstore.example.MyTestEntity';
const eventType = 'net.chrisrichardson.eventstore.example.MyEntityWasUpdatedEvent';
const swimlane = 2;
const events = helpers.makeEventsArr({ size: 10, entityType, eventType, swimlane });

describe('ObservableQueue', function () {

  this.timeout(timeout);

  it('should process all events', done => {

    let processedEvents = 0;

    const eventHandler = event => {
      return new Promise((resolve, reject) => {

        processedEvents++;

        if (processedEvents == events.length) {
          done();
        }

        resolve()
      });
    };

    const eventHandlers = {
      [entityType]: {
        [eventType]: eventHandler
      }
    };

    const queue = new ObservableQueue({ entityType, swimlane, eventHandlers });

    events.forEach((event) => {
      new Promise((resolve, reject) => {
        queue.queueEvent({ event, resolve, reject });
      });
    });
  });

  it('should stop processing if handler error', done => {

    let processedEventsCounter = 0;
    const breakpoint = 3;

    const eventHandler = () =>
      new Promise((resolve, reject) => {

        processedEventsCounter++;

        if (breakpoint === processedEventsCounter) {
          reject(new Error('Controlled exception'));
          //return done();
          return;
        }

        if (processedEventsCounter === events.length) {
          done(new Error('The queue did not interrupt'))
        }

        resolve();
      });

    const eventHandlers = {
      [entityType]: {
        [eventType]: eventHandler
      }
    };

    const queue = new ObservableQueue({ entityType, swimlane, eventHandlers });

    Promise.all(events.map((event) =>
      new Promise((rs, rj) => queue.queueEvent({ event, resolve: rs, reject: rj })))
    ).then(done, (err) => {
      if (err.message !== 'Controlled exception') {
        done(err);
      }
      done();
    });
  });
});
