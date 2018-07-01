import { getLogger } from './logger';
import { retryNTimes } from './utils';
import util from 'util';

const logger = getLogger({ title: 'EventuateClient:AggregateRepository' });
const EVENT_STORE_UTILS_RETRIES_COUNT = process.env.EVENT_STORE_UTILS_RETRIES_COUNT || 10;

export default class AggregateRepository {
    constructor({ eventuateClient = {}, EntityClass, retryErrConditionFn } = {}) {

    if (!eventuateClient) {
      throw new Error('The option `eventuateClient` is not provided.')
    }

    if (typeof (EntityClass) === 'function') {
      this.EntityClass = EntityClass;
    }

    this.eventuateClient = eventuateClient;
    let errConditionFn = retryErrConditionFn || function () {
      return false;
    };

    this.updateEntity = retryNTimes(
      {
        times: EVENT_STORE_UTILS_RETRIES_COUNT,
        fn: ({ EntityClass, entityId, command, options }) => {
          const entity = this.createEntityInstance(EntityClass);
          const { entityTypeName } = entity;
          let entityVersion;

          return this.loadEvents({ entityTypeName, entityId, options })
            .then(
              loadedEvents => {
                logger.debug('loadedEvents result:', loadedEvents);

                entityVersion = this.getEntityVersionFromEvents(loadedEvents);

                if (!entityVersion) {
                  return Promise.reject({ code: 404, message: `Can not get entityVersion: no events for ${entityTypeName} ${entityId}`});
                }

                //iterate through the events calling entity.applyEvent(..)
                this.applyEntityEvents(loadedEvents, entity);

                const processCommandMethod = this.getProcessCommandMethod(entity, command.commandType);

                const events = processCommandMethod.call(entity, command);

                return this.eventuateClient.update(entityTypeName, entityId, entityVersion, events, options);
              },
              err => {
                logger.error(`Load events failed: ${entityTypeName} ${entityId}`);
                logger.error(err);
                return Promise.reject(err);
              }
            )
            .then(
              result => {
                logger.debug(`Updated entity: ${EntityClass.name} ${entityId} ${JSON.stringify(result)}`);
                return Promise.resolve(result);
              },
              error => {
                logger.error(`Update entity failed!
                Entity class: ${EntityClass.name}
                entityId: ${entityId}
                command: ${util.inspect(command, false, 20)}`);
                logger.error(error);

                if (error.statusCode === 409) {
                  logger.debug(`Updated before, loading events instead - ${EntityClass.name} ${entityId}`);

                  delete options.triggeringEventToken;

                  logger.debug('entityTypeName, entityId, options', entityTypeName, entityId, options);

                  return this.loadEvents({ entityTypeName, entityId })
                    .then(loadedEvents => {
                      const lastEvent = loadedEvents[loadedEvents.length -1];
                      logger.info('loadedEvents:', loadedEvents);
                      const result = {
                        entityIdTypeAndVersion: {
                          entityId,
                          entityVersion
                        },
                        eventIds: [ lastEvent.id ]
                      };

                      return Promise.resolve(result);
                    }, err => {
                      logger.error('err:', err);
                      return Promise.reject(err);
                    }
                  );
                }

                return Promise.reject(error);
              }
            )
        },
        errConditionFn
      });
  }

  createEntity({ EntityClass, command, options }) {
    try {
      const entity = this.createEntityInstance(EntityClass);
      const processCommandMethod = this.getProcessCommandMethod(entity, command.commandType);
      const events = processCommandMethod.call(entity, command);

      return this.eventuateClient.create(entity.entityTypeName, events, options)
        .then(result=> {
            logger.debug(`Created entity: ${EntityClass.name} ${result.entityIdTypeAndVersion.entityId} ${JSON.stringify(result)}`);
            return result;
          },
          err => {
            logger.error(`Create entity failed: ${EntityClass.name}`);
            return Promise.reject(err);
          })
    } catch (err) {
      logger.error(`Create entity failed!
      Entity class: ${EntityClass.name}
      command: ${util.inspect(command, false, 20)}`);
      return Promise.reject(err);
    }
  }

  loadEvents({ entityTypeName, entityId, options }) {
    return this.eventuateClient.loadEvents(entityTypeName, entityId, options);
  }

  getApplyMethod(entity, eventType) {

    const defaultMethod = 'applyEvent';
    const methodName = `apply${eventType}`;

    if (typeof entity[methodName] === 'function') {
      return entity[methodName];
    } else if (typeof entity[defaultMethod] === 'function') {
      return entity[defaultMethod];
    } else {
      throw new Error(`Entity does not have method to ${methodName} for ${eventType}.`);
    }
  }

  getProcessCommandMethod(entity, commandType) {
    const defaultMethod = 'processCommand';
    let methodName = `process${commandType}`;

    if (typeof entity[methodName] === 'function') {
      return entity[methodName];
    } else if (typeof entity[defaultMethod] === 'function') {
      return entity[defaultMethod];
    } else {
      throw new Error(`Entity does not have method to ${methodName} for ${commandType}.`);
    }
  }

  getEntityVersionFromEvents(loadedEvents) {

    if (loadedEvents.length <= 0) {
      return false;
    }
    return loadedEvents[loadedEvents.length - 1].id;
  }

  applyEntityEvents(loadedEvents, entity) {
    loadedEvents.forEach(event => {
      const type = event.eventType.split('.').pop();
      const applyMethod = this.getApplyMethod(entity, type);

      applyMethod.call(entity, event);
    });
  }

  async find({ EntityClass, entityId, options = {} }) {
    const entity = this.createEntityInstance(EntityClass);
    try {
      let loadedEvents = await this.eventuateClient.loadEvents(entity.entityTypeName, entityId, options);
      if (!loadedEvents.length) {
        return false;
      }

      const { version } = options;

      if (version) {
        loadedEvents = this.getEventsByVersion(loadedEvents, version);
        if (!loadedEvents) {
          return false;
        }
      }
      this.applyEntityEvents(loadedEvents, entity);
      return entity;
    } catch (err) {
      logger.debug('AggregateRepository error:', err);
      throw err;
    }
  }

  createEntityInstance(EntityClass) {
    if (typeof (EntityClass) === 'function') {
      return new EntityClass();
    }
    return new this.EntityClass();
  }

  getEventsByVersion(loadedEvents, version) {
    const index = loadedEvents.findIndex(({ id }) => id === version);
    if (index >= 0) {
      return loadedEvents.slice(0, index +1);
    }
  }
}
