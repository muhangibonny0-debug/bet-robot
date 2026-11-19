import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:bet_brain/brain/engine.dart';
import 'package:bet_brain/brain/settle.dart';
import 'package:bet_brain/brain/silver.dart';
import 'package:bet_brain/core/config.dart';
import 'package:bet_brain/core/models.dart';
import 'package:bet_brain/core/store.dart';
import 'package:bet_brain/core/theme.dart';
import 'package:bet_brain/providers/api_ninjas.dart';
import 'package:bet_brain/providers/basket_odds.dart';
import 'package:bet_brain/providers/feed.dart';
import 'package:bet_brain/providers/sportscore.dart';
import 'package:bet_brain/providers/sync.dart';

const String _stateDesc = 'bet-robot-state';
const String _stateFile = 'state.json';
const List<String> _dn = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

String _env(String k) => (Platform.environment[k] ?? '').trim();

void _loadKeys() {
  const map = {
    'GH_TOKEN': 'gh', 'FD_KEY': 'fd', 'AF_KEY': 'af', 'SM_KEY': 'sm', 'OA_KEY': 'oa',
    'FV_KEY': 'fv', 'TR_KEY': 'tr', 'SS_KEY': 'ss', 'AN_KEY': 'an', 'BK_NAME': 'bk', 'GM_KEY': 'gm',
  };
  map.forEach((e, k) {
    final v = _env(e);
    if (v.isNotEmpty) Store.data[k] = v;
  });
}

Map<String, String> get _h => {
      'Authorization': 'Bearer ${Store.gh}',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'bet-robot',
    };

Future<dynamic> _req(String method, String path, {String? body}) async {
  final u = Uri.parse('https://api.github.com$path');
  http.Response r;
  if (method == 'GET') {
    r = await http.get(u, headers: _h).timeout(const Duration(seconds: 30));
  } else if (method == 'POST') {
    r = await http.post(u, headers: _h, body: body).timeout(const Duration(seconds: 30));
  } else {
    r = await http.patch(u, headers: _h, body: body).timeout(const Duration(seconds: 30));
  }
  if (r.statusCode < 200 || r.statusCode >= 300) {
    final b = r.body.length > 140 ? r.body.substring(0, 140) : r.body;
    throw Exception('GitHub HTTP ${r.statusCode}: $b');
  }
  return jsonDecode(r.body);
}

Future<String?> _stateId() async {
  for (var page = 1; page <= 3; page++) {
    final j = await _req('GET', '/gists?per_page=100&page=$page');
    if (j is! List || j.isEmpty) break;
    for (final g in j) {
      if (g is Map &&
          '${g['description']}' == _stateDesc &&
          g['files'] is Map &&
          (g['files'] as Map).containsKey(_stateFile)) {
        return '${g['id']}';
      }
    }
  }
  return null;
}

Future<Map<String, dynamic>> _loadState(String? id) async {
  if (id == null) return <String, dynamic>{};
  final j = await _req('GET', '/gists/$id');
  final files = j is Map ? j['files'] : null;
  final f = files is Map ? files[_stateFile] : null;
  if (f is! Map) return <String, dynamic>{};
  try {
    final d = jsonDecode('${f['content']}');
    if (d is Map) return Map<String, dynamic>.from(d);
  } catch (e) {
    // start again
  }
  return <String, dynamic>{};
}

Future<void> _saveState(String? id, Map<String, dynamic> st) async {
  final files = {
    _stateFile: {'content': jsonEncode(st)}
  };
  if (id == null) {
    await _req('POST', '/gists',
        body: jsonEncode({'description': _stateDesc, 'public': false, 'files': files}));
  } else {
    await _req('PATCH', '/gists/$id', body: jsonEncode({'files': files}));
  }
}

// was the app opened on any phone in the last 5 minutes? The apps send "open" to a free mailbox.
Future<bool> _appOpenRecently() async {
  if (kPresenceTopic.isEmpty) return false;
  try {
    final r = await http
        .get(Uri.parse('https://ntfy.sh/$kPresenceTopic/json?poll=1&since=10m'))
        .timeout(const Duration(seconds: 20));
    if (r.statusCode != 200) return false;
    final cut = DateTime.now().millisecondsSinceEpoch ~/ 1000 - 300;
    for (final line in r.body.split('\n')) {
      final s = line.trim();
      if (s.isEmpty) continue;
      try {
        final j = jsonDecode(s);
        if (j is Map && '${j['event']}' == 'message' && j['time'] is num && (j['time'] as num).toInt() >= cut) {
          return true;
        }
      } catch (e) {
        // skip a bad line
      }
    }
  } catch (e) {
    // no answer: treat as closed
  }
  return false;
}

// how much of the free data allowance is left: the usual reason a ticket cannot be built
Future<void> _quota() async {
  try {
    if (Store.oa.isNotEmpty) {
      final r = await http
          .get(Uri.parse('https://api.the-odds-api.com/v4/sports/?apiKey=${Store.oa}'))
          .timeout(const Duration(seconds: 20));
      print('Quota: Odds API credits left ${r.headers['x-requests-remaining'] ?? '?'} '
          '(used ${r.headers['x-requests-used'] ?? '?'}) HTTP ${r.statusCode}');
    } else {
      print('Quota: no Odds API key');
    }
  } catch (e) {
    print('Quota: Odds API check failed ($e)');
  }
  try {
    if (Store.af.isNotEmpty) {
      final r = await http
          .get(Uri.parse('https://v3.football.api-sports.io/status'), headers: {'x-apisports-key': Store.af})
          .timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      final q = j is Map && j['response'] is Map ? (j['response'] as Map)['requests'] : null;
      print('Quota: API-Football used ${q is Map ? q['current'] : '?'} of ${q is Map ? q['limit_day'] : '?'} today');
    }
  } catch (e) {
    print('Quota: API-Football check failed ($e)');
  }
}

// proof: read the friends feed back from GitHub and list the tickets it holds
Future<void> _verifyFeed() async {
  try {
    final id = Store.str('feed_id');
    if (id.isEmpty) {
      print('Proof: the friends feed has no gist yet');
      return;
    }
    final j = await _req('GET', '/gists/$id');
    final files = j is Map ? j['files'] : null;
    final f = files is Map ? files['feed.json'] : null;
    if (f is! Map) {
      print('Proof: feed file not found');
      return;
    }
    final d = jsonDecode('${f['content']}');
    final data = d is Map ? d['data'] : null;
    if (data is! Map) {
      print('Proof: the feed is empty');
      return;
    }
    final keys = data.keys.map((e) => '$e').toList()..sort();
    for (final k in keys.reversed.take(4)) {
      final m = data[k];
      if (m is! Map) continue;
      final mm = Map<String, dynamic>.from(m);
      print('Proof feed: $k · ${legsOf(mm).length} legs · ${totalOdds(mm).toStringAsFixed(2)} odds · ${slipStatus(mm)} · booking ${mm['bk'] is Map ? ((mm['bk'] as Map)['code'] ?? (mm['bk'] as Map)['err'] ?? 'link') : 'none'}');
    }
  } catch (e) {
    print('Proof: could not read the feed ($e)');
  }
}

String _hhmm(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

String _desc(Map<String, dynamic>? m) {
  if (m == null) return 'none';
  return 'made ${_hhmm(madeOf(m))} · ${legsOf(m).length} legs · ${totalOdds(m).toStringAsFixed(2)} odds · ${slipStatus(m)}';
}

// a ticket the bot can still book: nothing has started yet
bool _upcoming(Map<String, dynamic> m) {
  if (slipStatus(m) != 'PENDING') return false;
  final nowMs = DateTime.now().millisecondsSinceEpoch;
  for (final l in legsOf(m)) {
    final t = l['t'] is num ? (l['t'] as num).toInt() : 0;
    if (l['st'] != 'p' || t < nowMs + 10 * 60000) return false;
  }
  return true;
}

bool _hasCode(Map<String, dynamic> m) {
  final b = m['bk'];
  return b is Map && ('${b['code'] ?? ''}${b['link'] ?? ''}').isNotEmpty;
}

// BangBet booking by the guest bot (bot/bot.js). All or nothing: no link means the ticket was not booked.
Future<void> _book(List<MapEntry<String, Map<String, dynamic>>> items) async {
  if (items.isEmpty || _env('BOT_OFF') == 'true') return;
  Directory('bot/out').createSync(recursive: true);
  final input = {
    'tickets': [
      for (final e in items)
        {
          'key': e.key,
          'legs': [
            for (final l in legsOf(e.value))
              {
                'home': l['home'], 'away': l['away'], 't': l['t'], 'mk': l['mk'], 'sel': l['sel'],
                'line': l['line'], 'odds': l['odds'], 'label': l['label'], 'league': l['league'], 'sp': l['sp'],
              }
          ]
        }
    ]
  };
  File('bot/in.json').writeAsStringSync(jsonEncode(input));
  File('bot/out/result.json').writeAsStringSync('{"tickets":[]}');
  print('Booking: ${items.length} ticket(s) to BangBet as a guest (no login, no bet is placed)');
  try {
    final inst = await Process.run('bash', [
      '-c',
      'cd bot && npm install playwright --no-audit --no-fund >/dev/null 2>&1; npx playwright install --with-deps chromium >/dev/null 2>&1; echo browser-ready'
    ]).timeout(const Duration(minutes: 6));
    print('Booking: ${'${inst.stdout}'.trim()}');
    final r = await Process.run('node', ['bot/bot.js', 'book', 'bot/in.json', 'bot/out/result.json'])
        .timeout(const Duration(minutes: 11));
    final lines = '${r.stdout}'.split('\n').where((s) => s.trim().isNotEmpty).toList();
    for (final s in lines.skip(lines.length > 60 ? lines.length - 60 : 0)) {
      print(s);
    }
    final err = '${r.stderr}'.trim();
    if (err.isNotEmpty) print('Bot errors: ${err.split('\n').take(8).join(' | ')}');
  } on TimeoutException {
    print('Booking: the bot took too long and was stopped');
  } catch (e) {
    print('Booking: $e');
  }
  final f = File('bot/out/result.json');
  if (!f.existsSync()) {
    print('Booking: no result file');
    return;
  }
  final nowMs = DateTime.now().millisecondsSinceEpoch;
  try {
    final j = jsonDecode(f.readAsStringSync());
    final ts = j is Map ? j['tickets'] : null;
    if (ts is! List) return;
    for (final t in ts) {
      if (t is! Map) continue;
      final m = Store.raw('${t['key']}');
      if (m == null) continue;
      final ok = t['ok'] == true && ('${t['code'] ?? ''}${t['link'] ?? ''}').isNotEmpty;
      if (ok) {
        m['bk'] = {'code': '${t['code'] ?? ''}', 'link': '${t['link'] ?? ''}', 'n': t['added'], 'odds': t['total'], 'at': nowMs};
        print('Booking OK: ${t['key']} code ${t['code']} link ${t['link']}');
      } else {
        m['bk'] = {'err': '${t['why'] ?? 'unknown reason'}'};
        print('Booking not made: ${t['key']}: ${t['why']}');
      }
    }
  } catch (e) {
    print('Booking: could not read the result ($e)');
  }
}

// the BangBet link and code, added to the notification text
String _bkLine(Map<String, dynamic> m) {
  final b = m['bk'];
  if (b is! Map) return '';
  final link = '${b['link'] ?? ''}';
  final code = '${b['code'] ?? ''}';
  if (link.isNotEmpty) return '\nBangBet: $link${code.isNotEmpty ? ' (code $code)' : ''}';
  if (code.isNotEmpty) return '\nBangBet code: $code';
  return '';
}

// every notification is sent once. Its flag includes the ticket's creation time,
// so a rebuilt ticket (same day) gets its own notifications.
List<Map<String, String>> _events(String key, Map<String, dynamic> m, Map<String, dynamic> sent,
    int nowMs, bool silent, String today, bool capped) {
  final out = <Map<String, String>>[];
  final base = '$key@${madeOf(m)}';
  final newBefore = sent.containsKey('$base:new');
  void add(String flag, String title, String body) {
    if (sent.containsKey(flag)) return;
    sent[flag] = nowMs;
    if (!silent) out.add({'title': title, 'body': body});
  }

  final kind = '${m['kind']}';
  final legs = legsOf(m);
  if (legs.isEmpty) return out;
  var firstT = 0;
  var lastT = 0;
  for (final l in legs) {
    final t = l['t'] is num ? (l['t'] as num).toInt() : 0;
    if (t == 0) continue;
    if (firstT == 0 || t < firstT) firstT = t;
    if (t > lastT) lastT = t;
  }
  final odds = totalOdds(m).toStringAsFixed(2);
  final fresh = nowMs - madeOf(m) < 12 * 3600000;
  final status = slipStatus(m);
  final recent = lastT != 0 && nowMs - lastT < 12 * 3600000;
  final bk = _bkLine(m);

  if (kind == 'vvip') {
    if (key == 'shock:$today' && fresh) {
      final picks = legs
          .take(3)
          .map((l) => '${l['label']} @${l['odds'] is num ? (l['odds'] as num).toStringAsFixed(2) : l['odds']}')
          .join(' · ');
      add('$base:new', 'Today\'s VVIP Gold ticket is ready',
          '$picks${legs.length > 3 ? ' · +${legs.length - 3} more' : ''} · total $odds · first kick-off ${_hhmm(firstT)}$bk');
    }
    for (var i = 0; i < legs.length; i++) {
      final l = legs[i];
      final t = l['t'] is num ? (l['t'] as num).toInt() : 0;
      if (t == 0) continue;
      final h = '${l['home']}';
      final a = '${l['away']}';
      final ph = '${l['ph']}';
      if (nowMs >= t && nowMs - t < 3 * 3600000 && ph != 'FT') {
        add('$base:ko:$i', 'Kick-off: $h vs $a', '${l['label']} · odds ${l['odds']}');
      }
      if (ph == 'FT' && l['sc'] != null && nowMs - t < 10 * 3600000) {
        add('$base:ft:$i', 'Full time: $h ${l['sc']} $a', 'Pick: ${l['label']}');
      }
    }
    if (recent) {
      if (status == 'WON') {
        add('$base:won', '🎉 VVIP Gold won!', 'VVIP Gold $odds odds. Congratulations!');
      } else if (status == 'LOST') {
        var why = 'one leg did not win';
        for (final l in legs) {
          if (l['st'] == 'l') {
            why = '${l['home']} ${l['sc'] ?? ''} ${l['away']} (pick: ${l['label']})'.replaceAll('  ', ' ');
            break;
          }
        }
        add('$base:lost', 'VVIP Gold lost', 'Lost on: $why');
      }
    }
  } else if (kind == 'silver') {
    if (fresh) {
      final n = m['n'] is num ? (m['n'] as num).toInt() : 1;
      final until = lastT == 0 ? '' : ' · until ${_dn[DateTime.fromMillisecondsSinceEpoch(lastT).weekday - 1]}';
      add('$base:new', n > 1 ? 'VIP Silver rebuilt (ticket $n of 3 this week)' : 'VIP Silver ticket is ready',
          '${legs.length} legs · $odds odds$until$bk');
    }
    if (status == 'WON' && recent) {
      add('$base:won', '🎉 VIP Silver won!', 'VIP Silver $odds odds. Congratulations!');
    }
    if (status == 'LOST' && capped) {
      add('$base:final', 'VIP Silver lost', 'No more Silver tickets this week. The next one starts on Monday.');
    }
  }
  // a booking made later than the "ready" message is announced once, on its own
  if (bk.isNotEmpty && !sent.containsKey('$base:bk')) {
    if (newBefore) {
      add('$base:bk', 'BangBet booking ready', '${kind == 'silver' ? 'VIP Silver' : 'VVIP Gold'}$bk');
    } else {
      sent['$base:bk'] = nowMs;
    }
  }
  return out;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('robot', () async {
    HttpOverrides.global = null; // allow real internet inside the test

    Directory('notify').createSync(recursive: true);
    if (_env('TEST_PUSH') == 'true') {
      File('notify/out.json').writeAsStringSync(jsonEncode([
        {'title': 'BetAssist test', 'body': 'Notifications work.'}
      ]));
      print('Test notification written');
      return;
    }
    File('notify/out.json').writeAsStringSync('[]');
    if (_env('DISCOVER') == 'true') {
      print('Discover run: the tickets are not touched');
      return;
    }

    Store.onChange = () {};
    _loadKeys();

    if (_env('PROBE') == 'true') {
      print('App open in the last 5 minutes: ${await _appOpenRecently()}');
      await _quota();
      print(await SportScore.test());
      try {
        print(await ApiNinjas.test());
      } catch (e) {
        print('API Ninjas: $e');
      }
      final now = DateTime.now();
      try {
        final fx = await BasketOdds.week(now, now.add(const Duration(days: 7)));
        print('The Odds API basketball: ${BasketOdds.lastInfo}');
        for (final f in fx.take(4)) {
          print('${f.league}: ${f.home} vs ${f.away} · ${f.odds} · ${f.book}');
        }
      } catch (e) {
        print('The Odds API basketball: $e');
      }
      return;
    }

    if (Store.gh.isEmpty) throw Exception('GH_TOKEN secret is missing');
    if (!Engine.isBuilder) throw Exception('No data key is set (FD_KEY, AF_KEY, SM_KEY or OA_KEY)');

    final force = _env('REBUILD') == 'true';
    final bookNow = _env('BOOK_NOW') == 'true';
    final now = DateTime.now();
    final runStart = now.millisecondsSinceEpoch;
    if (now.timeZoneOffset.inHours != 3) {
      throw Exception('Time zone is not Africa/Kampala (offset ${now.timeZoneOffset.inHours})');
    }
    final today = ymd(now);
    final yday = ymd(DateTime(now.year, now.month, now.day - 1));
    final week = Silver.weekOf(now);
    print('Run: ${force ? 'REBUILD by hand' : (bookNow ? 'BOOK NOW by hand' : 'normal')} · $today ${_hhmm(runStart)} Kampala');
    await _quota();

    await Sync.pull();
    await Engine.dropBad();

    // Tickets are built when you are awake: from 06:00, or at night only if the app is open
    final awake = force || bookNow || now.hour >= 6 || await _appOpenRecently();
    print('Awake window: ${awake ? 'open' : 'closed (night, app not open)'}');

    final sid = await _stateId();
    final st = await _loadState(sid);
    final silent = (st.isEmpty || st['v'] != 2) && !force && !bookNow;
    st['v'] = 2;
    final attRaw = st['attempts'];
    final attempts = attRaw is Map ? Map<String, dynamic>.from(attRaw) : <String, dynamic>{};
    final sentRaw = st['sent'];
    final sent = sentRaw is Map ? Map<String, dynamic>.from(sentRaw) : <String, dynamic>{};
    var lastTry = st['lastTry'] is num ? (st['lastTry'] as num).toInt() : 0;
    final svRaw = st['sv'];
    final sv = svRaw is Map ? Map<String, dynamic>.from(svRaw) : <String, dynamic>{};

    String snap() => jsonEncode([
          Store.raw('shock:$today'),
          Store.raw('shock:$yday'),
          Silver.latest(week)?.value,
        ]);
    final before = snap();

    // 1) today's VVIP ticket (a "book now" run never builds anything)
    var have = Store.raw('shock:$today');
    Map<String, dynamic>? saved;
    if (force && have != null && '${have['kind']}' == 'vvip') {
      if (have['bet'] != null) {
        print('REBUILD: today\'s VVIP has a bet on it, so it is kept');
      } else {
        saved = have;
        Store.data.remove('shock:$today');
        attempts[today] = 0;
        lastTry = 0;
        have = null;
        print('REBUILD: today\'s old VVIP taken out, building a new one');
      }
    }
    if (bookNow) {
      print('BOOK NOW: no ticket is built in this run');
    } else if (have == null || '${have['kind']}' != 'vvip') {
      final n = attempts[today] is num ? (attempts[today] as num).toInt() : 0;
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      if (!awake) {
        print('VVIP waits for you (night, app not open)');
      } else if (n < 4 && nowMs - lastTry >= 20 * 60000) {
        Store.data['fg:$today'] = n;
        st['lastTry'] = nowMs;
        final note = await Engine.autoForge();
        final after = Store.data['fg:$today'];
        attempts[today] = after is num ? after.toInt() : n;
        print('VVIP: $note');
      } else {
        print('VVIP skipped (tries today: $n, last try ${(nowMs - lastTry) ~/ 60000} min ago)');
      }
    } else {
      print('Today\'s VVIP already exists, it is kept');
    }
    if (saved != null) {
      final nv = Store.raw('shock:$today');
      if (nv == null || '${nv['kind']}' != 'vvip') {
        Store.data['shock:$today'] = saved;
        print('REBUILD failed: the old VVIP was put back (the VVIP line above says why)');
      }
    }

    // 2) live scores and results
    await Settle.run((s) {});

    // 3) VIP Silver: same awake rule
    Silver.lastTry = force ? 0 : (sv['lastTry'] is num ? (sv['lastTry'] as num).toInt() : 0);
    Silver.triesToday = force ? 0 : ('${sv['day']}' == today && sv['tries'] is num ? (sv['tries'] as num).toInt() : 0);
    final sNote = bookNow
        ? 'VIP Silver: not built in a book-now run'
        : (awake ? await Silver.autoBuild(force: force) : 'VIP Silver: waits for you (night, app not open)');
    sv['lastTry'] = Silver.lastTry;
    sv['day'] = today;
    sv['tries'] = Silver.triesToday;
    st['sv'] = sv;
    print('Silver: $sNote');
    for (final line in Silver.log) {
      print('  Silver detail: $line');
    }

    // 4) BangBet booking for the tickets built in this run (or, by hand, for the current ones)
    final toBook = <MapEntry<String, Map<String, dynamic>>>[];
    bool wants(Map<String, dynamic> m) =>
        _upcoming(m) && (bookNow ? !_hasCode(m) : (madeOf(m) >= runStart && m['bk'] == null));
    final v1 = Store.raw('shock:$today');
    if (v1 != null && '${v1['kind']}' == 'vvip' && wants(v1)) toBook.add(MapEntry('shock:$today', v1));
    final s1 = Silver.latest(week);
    if (s1 != null && wants(s1.value)) toBook.add(MapEntry(s1.key, s1.value));
    if (toBook.isEmpty) {
      print('Booking: nothing to book in this run');
    } else {
      await _book(toBook);
    }

    print('Proof VVIP today: ${_desc(Store.raw('shock:$today'))}');
    print('Proof Silver week: ${_desc(Silver.latest(week)?.value)}');

    // 5) notifications (a manual run only looks at today's tickets)
    final events = <Map<String, String>>[];
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    for (final k in (force || bookNow) ? ['shock:$today'] : ['shock:$yday', 'shock:$today']) {
      final m = Store.raw(k);
      if (m == null || '${m['kind']}' != 'vvip') continue;
      events.addAll(_events(k, m, sent, nowMs, silent, today, false));
    }
    final sl = Silver.latest(week);
    if (sl != null) {
      final capped = Silver.tickets(week).length >= Silver.weekCap;
      events.addAll(_events(sl.key, sl.value, sent, nowMs, silent, today, capped));
    }

    // 6) publish for the phones, only when something changed (or after a manual run)
    final changed = snap() != before;
    if (changed || force || bookNow) {
      await Sync.pull();
      await Sync.push();
      await Feed.publish();
      print('Published: yes');
      await _verifyFeed();
    } else {
      print('Published: nothing changed');
    }

    // 7) save the notebook and the notification list
    final cutDay = ymd(DateTime(now.year, now.month, now.day - 8));
    attempts.removeWhere((k, v) => k.compareTo(cutDay) < 0);
    sent.removeWhere((k, v) => k.length > 16 && k.substring(6, 16).compareTo(cutDay) < 0);
    st['attempts'] = attempts;
    st['sent'] = sent;
    await _saveState(sid, st);
    File('notify/out.json').writeAsStringSync(jsonEncode(events));
    print('Notifications to send: ${events.length}');
  }, timeout: const Timeout(Duration(minutes: 25)));
}
