"""3D texture-library push flow: bytes are localised sha-named under
portal/textures, map_json carries viewer-shaped {name: {url, tile_ft}},
stub-only pushes for files we lack answer need_textures, and session
create purges the store."""
import base64
import hashlib
import json
import os

from conftest import GM_HEADERS

PORTAL_TEX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'portal', 'textures')

PNG_1PX = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB'
    'h6FO1AAAAABJRU5ErkJggg==')


def _tex_entry(raw=PNG_1PX, with_data=True, tile_ft=6):
    sha = hashlib.sha256(raw).hexdigest()[:32]
    entry = {'sha': sha, 'ext': 'png', 'tile_ft': tile_ft}
    if with_data:
        entry['data'] = base64.b64encode(raw).decode('ascii')
    return sha, entry


def _push(client, session_id, textures):
    body = {'session_id': session_id,
            'map': {'url': '', 'grid_cols': 20, 'grid_rows': 20, 'tokens': [],
                    'floorplan': {'walls': []}, 'floorplan_version': 1,
                    'doors': {}, 'textures': textures}}
    r = client.post('/api/v1/session/push', headers=GM_HEADERS, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _stored_map(client, session_id):
    import sqlite3
    path = os.environ['DATABASE_URL'].split('sqlite:///', 1)[1]
    conn = sqlite3.connect(path)
    row = conn.execute('SELECT map_json FROM sessions WHERE id = ?',
                       (session_id,)).fetchone()
    conn.close()
    return json.loads(row[0])


class TestTexturePush:
    def test_bytes_stored_and_rewritten_for_viewer(self, client, session_id):
        sha, entry = _tex_entry()
        d = _push(client, session_id, {'flagstone': entry})
        assert 'need_textures' not in d
        path = os.path.join(PORTAL_TEX, f'{sha}.png')
        assert os.path.exists(path)
        m = _stored_map(client, session_id)
        assert m['textures']['flagstone'] == {'url': f'/textures/{sha}.png',
                                              'tile_ft': 6}
        # transfer fields never reach map_json
        assert 'data' not in json.dumps(m)
        # and the file is actually served
        r = client.get(f'/textures/{sha}.png')
        assert r.status_code == 200 and r.content == PNG_1PX

    def test_stub_for_missing_file_answers_need_textures(self, client, session_id):
        sha, entry = _tex_entry(with_data=False)
        # make sure the store is empty of this sha
        p = os.path.join(PORTAL_TEX, f'{sha}.png')
        if os.path.exists(p):
            os.remove(p)
        d = _push(client, session_id, {'flagstone': entry})
        assert d.get('need_textures') == ['flagstone']
        m = _stored_map(client, session_id)
        # unusable entry dropped — viewer falls back to art-sampled surfaces
        assert 'textures' not in m
        # the re-push WITH bytes completes the pair
        sha2, entry2 = _tex_entry(with_data=True)
        d2 = _push(client, session_id, {'flagstone': entry2})
        assert 'need_textures' not in d2
        assert _stored_map(client, session_id)['textures']['flagstone']['url'] \
            == f'/textures/{sha2}.png'

    def test_stub_for_existing_file_reuses_it(self, client, session_id):
        sha, entry = _tex_entry(with_data=True)
        _push(client, session_id, {'flagstone': entry})
        stub = dict(entry)
        del stub['data']
        d = _push(client, session_id, {'flagstone': stub})
        assert 'need_textures' not in d
        assert _stored_map(client, session_id)['textures']['flagstone']['url'] \
            == f'/textures/{sha}.png'

    def test_prune_keeps_only_current_set(self, client, session_id):
        sha_a, entry_a = _tex_entry(PNG_1PX)
        other = PNG_1PX + b'x'
        sha_b, entry_b = _tex_entry(other)
        _push(client, session_id, {'a': entry_a, 'b': entry_b})
        assert os.path.exists(os.path.join(PORTAL_TEX, f'{sha_a}.png'))
        assert os.path.exists(os.path.join(PORTAL_TEX, f'{sha_b}.png'))
        _push(client, session_id, {'a': entry_a})
        assert os.path.exists(os.path.join(PORTAL_TEX, f'{sha_a}.png'))
        assert not os.path.exists(os.path.join(PORTAL_TEX, f'{sha_b}.png'))

    def test_session_create_purges_texture_store(self, client, session_id):
        sha, entry = _tex_entry()
        _push(client, session_id, {'flagstone': entry})
        assert os.listdir(PORTAL_TEX)
        r = client.post('/api/v1/session/create', headers=GM_HEADERS, json={})
        assert r.status_code == 200
        assert not [f for f in os.listdir(PORTAL_TEX) if not f.startswith('.')]

    def test_push_without_textures_untouched(self, client, session_id):
        d = _push(client, session_id, None)
        assert d == {'ok': True}
