import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:bet_brain/brain/engine.dart';
import 'package:bet_brain/brain/settle.dart';
import 'package:bet_brain/brain/silver.dart';
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
    'FV_KEY': 'fv', 'TR_KEY': 'tr', 'SS_KEY': 'ss', 'AN_KEY': 'an', 'BK_NAME': 'bk',
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

String _hhmm(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

// every notification is sent once: its flag is saved in the robot notebook
List<Map<String, String>> _events(String key, Map<String, dynamic> m, Map<String, dynamic> sent,
    int nowMs, bool silent, String today, bool capped) {
  final out = <Map<String, String>>[];
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

  if (kind == 'vvip') {
    if (key == 'shock:$today' && fresh) {
      add('$key:new', 'Today\'s VVIP Gold ticket is ready',
          '${legs.length} ${legs.length == 1 ? 'leg' : 'legs'} · $odds odds · first kick-off ${_hhmm(firstT)}');
    }
    for (var i = 0; i < legs.length; i++) {
      final l = legs[i];
      final t = l['t'] is num ? (l['t'] as num).toInt() : 0;
      if (t == 0) continue;
      final h = '${l['home']}';
      final a = '${l['away']}';
      final ph = '${l['ph']}';
      if (nowMs >= t && nowMs - t < 3 * 3600000 && ph != 'FT') {
        add('$key:ko:$i', 'Kick-off: $h vs $a', '${l['label']} · odds ${l['odds']}');
      }
      if (ph == 'FT' && l['sc'] != null && nowMs - t < 10 * 3600000) {
        add('$key:ft:$i', 'Full time: $h ${l['sc']} $a', 'Pick: ${l['label']}');
      }
    }
    if (recent) {
      if (status == 'WON') {
        add('$key:won', '🎉 VVIP Gold won!', 'VVIP Gold $odds odds. Congratulations!');
      } else if (status == 'LOST') {
        var why = 'one leg did not win';
        for (final l in legs) {
          if (l['st'] == 'l') {
            why = '${l['home']} ${l['sc'] ?? ''} ${l['away']} (pick: ${l['label']})'.replaceAll('  ', ' ');
            break;
          }
        }
        add('$key:lost', 'VVIP Gold lost', 'Lost on: $why');
      }
    }
  } else if (kind == 'silver') {
    if (fresh) {
      final n = m['n'] is num ? (m['n'] as num).toInt() : 1;
      final until = lastT == 0 ? '' : ' · until ${_dn[DateTime.fromMillisecondsSinceEpoch(lastT).weekday - 1]}';
      add('$key:new', n > 1 ? 'VIP Silver rebuilt (ticket $n of 3 this week)' : 'VIP Silver ticket is ready',
          '${legs.length} legs · $odds odds$until');
    }
    if (status == 'WON' && recent) {
      add('$key:won', '🎉 VIP Silver won!', 'VIP Silver $odds odds. Congratulations!');
    }
    if (status == 'LOST' && capped) {
      add('$key:final', 'VIP Silver lost', 'No more Silver tickets this week. The next one starts on Monday.');
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

    Store.onChange = () {};
    _loadKeys();

    if (_env('PROBE') == 'true') {
      // only looks at the data providers and prints what they return
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

    final now = DateTime.now();
    if (now.timeZoneOffset.inHours != 3) {
      throw Exception('Time zone is not Africa/Kampala (offset ${now.timeZoneOffset.inHours})');
    }
    final today = ymd(now);
    final yday = ymd(DateTime(now.year, now.month, now.day - 1));
    final week = Silver.weekOf(now);

    await Sync.pull();
    await Engine.dropBad();

    final sid = await _stateId();
    final st = await _loadState(sid);
    final silent = st.isEmpty; // the very first run only learns, it sends nothing
    final attRaw = st['attempts'];
    final attempts = attRaw is Map ? Map<String, dynamic>.from(attRaw) : <String, dynamic>{};
    final sentRaw = st['sent'];
    final sent = sentRaw is Map ? Map<String, dynamic>.from(sentRaw) : <String, dynamic>{};
    final lastTry = st['lastTry'] is num ? (st['lastTry'] as num).toInt() : 0;
    final svRaw = st['sv'];
    final sv = svRaw is Map ? Map<String, dynamic>.from(svRaw) : <String, dynamic>{};

    String snap() => jsonEncode([
          Store.raw('shock:$today'),
          Store.raw('shock:$yday'),
          Silver.latest(week)?.value,
        ]);
    final before = snap();

    // 1) today's VVIP ticket, once, never more than 4 tries a day and 20 minutes apart
    final have = Store.raw('shock:$today');
    if (have == null || '${have['kind']}' != 'vvip') {
      final n = attempts[today] is num ? (attempts[today] as num).toInt() : 0;
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      if (n < 4 && nowMs - lastTry >= 20 * 60000) {
        Store.data['fg:$today'] = n;
        st['lastTry'] = nowMs;
        final note = await Engine.autoForge();
        final after = Store.data['fg:$today'];
        attempts[today] = after is num ? after.toInt() : n;
        print('VVIP: $note');
      } else {
        print('VVIP skipped (tries today: $n)');
      }
    } else {
      print('Today\'s VVIP already exists');
    }

    // 2) live scores and results
    await Settle.run((s) {});

    // 3) VIP Silver, built by the robot when the rules allow it
    Silver.lastTry = sv['lastTry'] is num ? (sv['lastTry'] as num).toInt() : 0;
    Silver.triesToday = '${sv['day']}' == today && sv['tries'] is num ? (sv['tries'] as num).toInt() : 0;
    final sNote = await Silver.autoBuild();
    sv['lastTry'] = Silver.lastTry;
    sv['day'] = today;
    sv['tries'] = Silver.triesToday;
    st['sv'] = sv;
    print('Silver: ${sNote.isEmpty ? 'nothing due' : sNote}');

    // 4) notifications
    final events = <Map<String, String>>[];
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    for (final k in ['shock:$yday', 'shock:$today']) {
      final m = Store.raw(k);
      if (m == null || '${m['kind']}' != 'vvip') continue;
      events.addAll(_events(k, m, sent, nowMs, silent, today, false));
    }
    final sl = Silver.latest(week);
    if (sl != null) {
      final capped = Silver.tickets(week).length >= Silver.weekCap;
      events.addAll(_events(sl.key, sl.value, sent, nowMs, silent, today, capped));
    }

    // 5) publish for the phones, only when something changed
    if (snap() != before) {
      await Sync.pull();
      await Sync.push();
      await Feed.publish();
      print('Published');
    }

    // 6) save the notebook and the notification list
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
