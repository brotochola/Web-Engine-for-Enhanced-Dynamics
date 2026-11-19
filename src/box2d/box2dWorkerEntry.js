// SST-12: the physics worker's entry in a source build. The Box2D glue (box2dWasm.js) runs weedjsPost.js, which runs its
// sixteen sibling scripts, then physicsHostImpl.js, all through synchronous importScripts, one request after another:
// 760 to 1 335 ms of a source start (R-1500). This entry fetches the glue, weedjsPost.js, the host and the siblings at
// once, then runs them in the same order from blob URLs (as the bundle's physics worker does), each named by its file
// for stack traces and the debugger. Messages that come before the host is in are held and handed to it in order. The
// glue's pthread pool workers are made from this script too (Emscripten spawns its own script, named 'em-pthread'): they
// load the glue directly, as before. A file that does not come falls back to the glue's own importScripts.

(function () {
  'use strict';
  var search = self.location.search;
  if (self.name === 'em-pthread') {
    importScripts('box2dWasm.js' + search);
    return;
  }

  var base = new URL('.', self.location.href).href;
  var origin = performance.timeOrigin;
  var marks = ['entry evaluated', origin + performance.now()];
  var held = [];
  function hold(event) {
    held.push(event);
  }
  self.addEventListener('message', hold);
  var nativeImportScripts = self.importScripts.bind(self);

  function fetchText(name, query) {
    return fetch(base + name + (query || '')).then(function (response) {
      if (!response.ok) throw new Error(name + ': HTTP ' + response.status);
      return response.text();
    });
  }

  /** The quoted .js names in weedjsPost.js's first importScripts(...) (buildBundle.js reads the same list). */
  function siblingNames(post) {
    var match = post.match(/importScripts\s*\(([\s\S]*?)\)/);
    if (!match) return [];
    var names = [];
    var re = /['"]([^'"]+\.js)['"]/g;
    var m;
    while ((m = re.exec(match[1])) !== null) names.push(m[1]);
    return names;
  }

  /** The held messages, in order, to the host's handler (it set self.onmessage while the glue ran). */
  function release() {
    self.removeEventListener('message', hold);
    for (var i = 0; i < held.length; i++) {
      var e = held[i];
      self.dispatchEvent(new MessageEvent('message', { data: e.data, ports: e.ports ? Array.prototype.slice.call(e.ports) : [] }));
    }
    held = [];
  }

  var post = fetchText('weedjsPost.js');
  var siblings = post.then(function (text) {
    return Promise.all(siblingNames(text).map(function (name) {
      return fetchText(name).then(function (source) {
        return [name, source];
      });
    }));
  });

  Promise.all([fetchText('box2dWasm.js', search), post, fetchText('physicsHostImpl.js'), siblings]).then(
    function (texts) {
      var blobs = Object.create(null);
      function blobOf(name, source) {
        return URL.createObjectURL(new Blob([source + '\n//# sourceURL=' + base + name + '\n'], { type: 'text/javascript' }));
      }
      blobs['weedjsPost.js'] = blobOf('weedjsPost.js', texts[1]);
      blobs['physicsHostImpl.js'] = blobOf('physicsHostImpl.js', texts[2]);
      for (var i = 0; i < texts[3].length; i++) blobs[texts[3][i][0]] = blobOf(texts[3][i][0], texts[3][i][1]);
      self.importScripts = function () {
        var urls = Array.prototype.map.call(arguments, function (url) {
          var name = String(url).split('/').pop().split('?')[0];
          return blobs[name] || url;
        });
        return nativeImportScripts.apply(self, urls);
      };
      marks.push('scripts fetched', origin + performance.now());
      self.__weedPhysicsLoadMarks = marks;
      // The glue, which runs weedjsPost.js and the host (and they their siblings) through the importScripts above. An
      // error there reaches the page as the worker's error, as it did from the glue's own importScripts.
      try {
        nativeImportScripts(blobOf('box2dWasm.js', texts[0]));
      } catch (error) {
        setTimeout(function () {
          throw error;
        });
        return;
      }
      release();
    },
    function (error) {
      console.warn('[physics] the entry could not fetch the physics scripts (' + (error && error.message) + '): loading them one by one');
      self.__weedPhysicsLoadMarks = marks;
      nativeImportScripts('box2dWasm.js' + search);
      release();
    },
  );
})();
