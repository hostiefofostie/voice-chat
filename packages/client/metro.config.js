const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Stub onnxruntime-web on native platforms — it uses dynamic WASM imports
// that Metro can't bundle. The web VAD (which needs it) is only loaded on
// Platform.OS === 'web' via a dynamic import, so native never actually
// executes the code.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'onnxruntime-web' && platform !== 'web') {
    return { type: 'empty' };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
