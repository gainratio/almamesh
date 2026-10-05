/*
 * Close every IndexedDB connection this page opens as soon as another context
 * deletes or upgrades that database (the standard `versionchange` contract).
 *
 * idb-keyval keeps its connection open and never handles `versionchange`, so
 * "Reset & reload" found keyval-store blocked (WebKit kept it blocked even after
 * the reload) while user rows could still be on disk. Patching the one `open`
 * entry point covers every library; `addEventListener` leaves their own
 * handlers alone, and idb-keyval reopens lazily after a close.
 *
 * A classic script, loaded before any module: zustand stores begin hydrating
 * (and open IndexedDB) while their chunks evaluate, ahead of main.tsx's body.
 * Tested by src/lib/__tests__/idbConnectionHygiene.test.ts.
 */
(function (factory) {
  var installed = '__almameshCloseOnVersionChange';
  if (!factory || factory[installed]) return;
  var open = factory.open.bind(factory);
  factory.open = function (name, version) {
    var request = version === undefined ? open(name) : open(name, version);
    request.addEventListener('success', function () {
      var database = request.result;
      database.addEventListener('versionchange', function () {
        database.close();
      });
    });
    return request;
  };
  factory[installed] = true;
})(globalThis.indexedDB);
