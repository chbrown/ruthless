#!/usr/bin/env node
var fs = require('fs');
var http = require('http');
var https = require('https');
var urllib = require('url');
var zlib = require('zlib');

var async = require('async');
var pg = require('pg');
var argv = require('optimist').argv;
var pg_config = {user: process.env.USER, database: 'ruthless'};

function logerr(err) { if (err) console.error(err); }

function query(sql, args, callback) {
  pg.connect(pg_config, function(err, client) {
    if (err) console.error('pg.connect error:', err);
    client.query(sql, args, callback);
  });
}

// jschardet = require('jschardet'),
// Iconv = require('iconv').Iconv,
// jschardet.detect();
// cheerio = require('cheerio'),

function GET(url, callback) {
  // url should be a url.parse()'d object, protocol is mandatory
  (url.protocol === 'https:' ? https : http).get(url, function(response) {
    if (response.statusCode >= 300 && response.statusCode <= 303) {
      // redirect
      GET(urllib.resolve(url, response.headers.location), callback);
    }
    else if (!response.headers['content-type'].match(/text\/html/)) {
      callback('Not html');
    }
    else {
      var read_stream = response;
      if (response.headers['content-encoding'] === 'gzip')
        read_stream = response.pipe(zlib.createGunzip());
      if (response.headers['content-encoding'] === 'deflate')
        read_stream = response.pipe(zlib.createInflate());
      var body = '';
      read_stream.on('data', function(chunk) {body += chunk;});
      read_stream.on('end', function() {
        callback(undefined, body);
      });
    }
  }).on('error', callback);
}

// seen is just a local cache to avoid all the unique conflicts on (tag, url)
// it's not preloaded with a `SELECT url FROM pages`, though maybe it should be.
// It's not required, but it can prevent having to make lots of INSERTs that fail
// due to the UNIQUE constraint on (tag, url)
var seen = {};

function fetch(id, urlStr, tag, depth, callback) {
  var urlObj = urllib.parse(urlStr);
  GET(urlObj, function(err, html) {
    if (!urlObj.protocol)
      urlObj.protocol = 'http:';

    if (err) {
      query('UPDATE pages SET failed = NOW(), error = $1 WHERE id = $2', [err.toString(), id], callback);
    }
    else {
      var href_match, href, re = /href\s*=\s*('|")(.+?)\1/g, hrefs = {};
      while (href_match = re.exec(html)) {
        href = href_match[2].replace(/#.+/g, '').replace(/&amp;/g, '&');
        hrefs[href] = 1;
      }
      hrefs = Object.keys(hrefs);

      async.forEachSeries(hrefs,
        function(href, callback) {
          // sanitize the url a little bit. not sure why this happens.
          if (href.match(/^http%3A%2F%2F/)) {
            href = decodeURIComponent(href);
          }
          var child_urlStr = urllib.resolve(urlObj, href),
            child_urlObj = urllib.parse(child_urlStr),
            new_depth = depth + (child_urlObj.hostname === urlObj.hostname ? 1 : 100);

          if (href.match(/^mailto:/)) {
            // ignore email links
            callback(null);
          }
          else if (seen[tag + child_urlStr]) {
            callback(null);
          }
          else {
            query('INSERT INTO pages (parent_id, url, tag, depth) VALUES ($1, $2, $3, $4)', [id, child_urlStr, tag, new_depth], function(err, res) {
              // basically ignore the insertion unique violation, if it conflicts
              if (err && err.message.match(/violates unique constraint/))
                err = null;
              callback(err);
              seen[tag + child_urlStr] = 1;
            });
          }
        },
        function(err) {
          logerr(err);
          console.log('GET ' + urlStr + ' [' + depth + '] - adding ' + hrefs.length + ' urls.');
          query('UPDATE pages SET fetched = NOW(), content = $1 WHERE id = $2', [html, id], callback);
        }
      );
    }
  });
}

// actually parse the DOM:
// var $ = cheerio.load(html), hrefs = {};
// $('a').each(function() {
//   var href = this.attr('href');
//   if (href)
//     hrefs[href.replace(/#.+/g, '')] = 1;
//   else
//     console.dir(this);
// });

// work is called from loop, which is my attempt to recurse infinitely without proper tail recursion
// Hey v8 devs! How about some true LISPy tail recursion?
function work(callback) {
  query('SELECT depth FROM pages WHERE fetched IS NULL \
         AND failed IS NULL ORDER BY depth LIMIT 1', function(err, min_depth) {
    if (min_depth.rows.length) {
      query('SELECT id, url, tag, depth FROM pages WHERE fetched IS NULL \
             AND failed IS NULL AND depth = $1 LIMIT 10000', [min_depth.rows[0].depth], function(err, results) {
        logerr(err);
        var random_index = Math.random() * results.rows.length | 0;
        var page = results.rows[random_index];
        fetch(page.id, page.url, page.tag, page.depth, function(err) {
          logerr(err);
          callback();
        });
      });
    }
    else {
      console.log('Queue is empty');
    }
  });
}

// this is like a `if __name__ == '__main__':` conditional.
if (require.main === module) {
  var loop = function() {
    process.nextTick(function() {
      work(loop);
    });
  };

  var tag = argv.tag, urls = argv._;
  async.forEach(urls,
    function(url, callback) {
      query('INSERT INTO pages (url, tag, depth) VALUES ($1, $2, $3)', [url, tag, 0], function(err) {
        if (err && err.message.match(/violates unique constraint/)) {
          // minimize depth if it already exists
          query('UPDATE pages SET depth = $1 WHERE url = $2', [0, url], function(err) {
            callback(err);
          });
        }
        else {
          callback();
        }
      });
    },
    function(err) {
      logerr(err);
      if (urls.length)
        console.log('Queued ' + urls.length + ' urls with tag: ' + tag);
      loop();
    }
  );
}

// process.on('SIGINT', function () {
//   console.log('Got SIGINT. Attempting to flush counts buffer and exiting.');
//   process.exit(0);
// });

// // fix bad urls
// query("SELECT id, url FROM pages WHERE url LIKE '%&amp;%' ORDER BY depth", function(err, result) {
//   logerr(err);
//   async.forEachSeries(result.rows,
//     function(row, callback) {
//       var new_url = row.url.replace(/&amp;/g, '&');
//       console.log(row.url, '->', new_url);
//       query('UPDATE pages SET url = $1, fetched = NULL WHERE id = $2', [new_url, row.id], function(err) {
//         if (err && err.message.match(/violates unique constraint/)) {
//           err = null;
//         }
//         callback(err);
//       });
//     },
//     function(err) {
//       logerr(err);
//       console.log('Done fixing');
//     }
//   );
// });
