'use strict';
const helpers = require('./lib/helpers');
const Encryption = require('../dist/modules/Encryption');

const encryptionKeyId = 'id';
const keySecret = Encryption.genEncryptionKey();

class EncryptionStore {
  constructor(keys) {
    this.keys = keys;
  }

  get(encryptionKeyId) {
    return Promise.resolve(this.keys[encryptionKeyId]);
  }

  removeKey(encryptionKeyId) {
    delete this.keys[encryptionKeyId];
    return Promise.resolve();
  }
}
const encryptionKeyStore = new EncryptionStore({ [encryptionKeyId]: keySecret });
const encryption = new Encryption(encryptionKeyStore);

const entityTypeName = `net.chrisrichardson.eventstore.example.MyEntity-${helpers.getUniqueID()}`;
const entityWasCreatedEvent = 'net.chrisrichardson.eventstore.example.MyEntityWasCreated';
const entityWasChangedEvent = 'net.chrisrichardson.eventstore.example.MyEntityNameChanged';
const entityTypesAndEvents = {
  [entityTypeName]: [
    entityWasCreatedEvent,
    entityWasChangedEvent
  ]
};

console.log('entityTypesAndEvent:', entityTypesAndEvents);

let eventIds = [];

before(done => {
  const eventuateClient = helpers.createEventuateClient(encryption);
  const createEvents = [ { eventType:  entityWasCreatedEvent, eventData: '{"name":"Fred"}' } ];

  //create events
  eventuateClient.create(entityTypeName, createEvents, { encryptionKeyId }, (err, createdEntityAndEventInfo) => {
    if (err) {
      return done(err);
    }

    helpers.expectCommandResult(createdEntityAndEventInfo);
    eventIds = eventIds.concat(createdEntityAndEventInfo.eventIds);

    //update events
    const entityIdTypeAndVersion = createdEntityAndEventInfo.entityIdTypeAndVersion;
    const entityId = entityIdTypeAndVersion.entityId;
    const entityVersion = createdEntityAndEventInfo.eventIds[0];
    const updateEvents = [{ eventType: 'net.chrisrichardson.eventstore.example.MyEntityNameChanged', eventData: '{"name":"George"}' }];

    eventuateClient.update(entityTypeName, entityId, entityVersion, updateEvents, { encryptionKeyId }, (err, updatedEntityAndEventInfo) => {
      if (err) {
        return done(err);
      }

      helpers.expectCommandResult(updatedEntityAndEventInfo);

      console.log('Created events');
      done();
    });
  });
});

describe('Subscribe for 2 events', function () {
  this.timeout(25000);

  it('should fail', done => {
    try {
    class EncryptionStore2 extends EncryptionStore {
      constructor() {
        super();
      }
      get() {
        return Promise.reject(new Error('ResourceNotFoundException'));
      }
    }
    const eventuateClient = helpers.createEventuateClient(new Encryption(new EncryptionStore2()));

    const subscriberId = `subscriber-${helpers.getUniqueID()}`;

    const eventHandler = (event) => {
      return new Promise((resolve, reject) => {
        console.log('Event handler event:', event);

        helpers.expectEvent(event);
        resolve(event.ack);
      });
    };


      eventuateClient.subscribe(subscriberId, entityTypesAndEvents, eventHandler, err => {
        if (err) {
          return done(err)
        }

        console.log('The subscription has been established.')
      });
    } catch (err) {
      done();
    }
  });
});
