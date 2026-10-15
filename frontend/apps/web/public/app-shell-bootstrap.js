(function () {
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var publicPaths = ['/', '/welcome', '/privacy', '/terms', '/data-deletion', '/how-we-test'];
  if (publicPaths.indexOf(path) === -1) {
    var root = document.getElementById('root');
    if (root) root.innerHTML = '';
  }
})();
