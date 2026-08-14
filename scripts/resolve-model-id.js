'use strict';

const fraudxClient = require('../fraudx-client');

async function resolveModelId(base, auth, displayName, typeName, timeoutMs) {
  const models = await fraudxClient.searchModels(base, auth, typeName, timeoutMs);
  const match = models.find((model) => model.displayName === displayName);
  if (!match) {
    throw new Error(`No ${typeName} model found with displayName "${displayName}"`);
  }
  return match.id;
}

module.exports = resolveModelId;
