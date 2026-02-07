const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// onnxruntime-web uses dynamic import(variable) syntax that Metro's JS parser
// cannot handle. On web we redirect to a shim that re-exports globalThis.ort
// (loaded from CDN via a <script> tag in app/+html.tsx). On native we return
// an empty module since the web VAD code path is never reached.
const onnxShim = path.resolve(__dirname, 'shims', 'onnxruntime-web.js');
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'onnxruntime-web' || moduleName.startsWith('onnxruntime-web/')) {
    if (platform !== 'web') {
      return { type: 'empty' };
    }
    return {
      type: 'sourceFile',
      filePath: onnxShim,
    };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
