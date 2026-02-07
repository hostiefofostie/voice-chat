// Metro can't parse onnxruntime-web's dynamic import(variable) syntax.
// This shim is resolved in place of onnxruntime-web by metro.config.js.
// The real onnxruntime-web is loaded from CDN via a <script> tag injected
// by useAudioCapture's loadOnnxRuntime(), which populates globalThis.ort.
//
// We use a Proxy so that property access always delegates to the live
// globalThis.ort object, regardless of when this module is first evaluated.
// The __esModule flag ensures vad-web's __importStar returns the proxy
// directly instead of copying (empty) own-properties into a new object.
module.exports =
  typeof Proxy !== 'undefined'
    ? new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === '__esModule') return true;
            var ort = typeof globalThis !== 'undefined' && globalThis.ort;
            return ort ? ort[prop] : undefined;
          },
          has(_, prop) {
            if (prop === '__esModule') return true;
            var ort = typeof globalThis !== 'undefined' && globalThis.ort;
            return ort ? prop in ort : false;
          },
        },
      )
    : {};
