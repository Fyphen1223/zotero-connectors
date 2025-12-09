/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2025 Corporation for Digital Scholarship
					Vienna, Virginia, USA
					http://zotero.org
	
	This file is part of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

import { Tab, stubHTTPRequest } from '../support/utils.mjs';

describe("Server save targets", function() {
	let tab = new Tab();

	before(async function() {
		await tab.init();
	});

	after(async function () {
		await tab.close();
	});

	it('loads library collections and tags from zotero.org', async function() {
		const restoreHTTP = await stubHTTPRequest({
			'users/1/groups': [{ data: { id: 5, name: 'Group Library', fileEditing: 'members', libraryEditing: 'members' } }],
			'users/1/collections': [{ data: { key: 'AAAA', name: 'User Collection', parentCollection: false } }],
			'groups/5/collections': [{ data: { key: 'BBBB', name: 'Group Collection', parentCollection: false } }],
			'users/1/tags': [{ tag: 'alpha' }],
			'groups/5/tags': [{ tag: 'beta' }]
		});

		try {
			const result = await tab.run(async function () {
				Zotero.Prefs.set('auth-token_secret', 'token');
				Zotero.Prefs.set('auth-userID', '1');
				Zotero.Prefs.set('auth-username', 'Test User');
				const selection = await Zotero.API.getServerLibraryTargets(true);
				return {
					targets: selection.targets.map(t => ({ id: t.id, level: t.level, collectionKey: t.collectionKey })),
					tags: selection.tags
				};
			});

			const targetIds = result.targets.map(t => t.id);
			assert.includeMembers(targetIds, ['Luser-1', 'Cuser-1-AAAA', 'Lgroup-5', 'Cgroup-5-BBBB']);
			assert.strictEqual(result.targets.find(t => t.id === 'Cuser-1-AAAA').level, 1);
			assert.deepEqual(result.tags['Luser-1'], ['alpha']);
			assert.deepEqual(result.tags['Lgroup-5'], ['beta']);
		}
		finally {
			await restoreHTTP();
		}
	});

	it('applies selected collection when saving to zotero.org', async function() {
		const payload = await tab.run(async function () {
			let captured;
			sinon.stub(Zotero.API, 'createItem').callsFake(async function(items, askForAuth, library) {
				captured = { items, library };
				return JSON.stringify({ success: {0: 'ITEMKEY'}, failed: {} });
			});
			try {
				const itemSaver = new Zotero.ItemSaver({
					sessionID: 'session-1',
					serverTarget: {
						id: 'Cuser-1-AAAA',
						libraryType: 'user',
						libraryID: '1',
						collectionKey: 'AAAA'
					}
				});
				const items = [{
					itemType: 'book',
					title: 'Test Book',
					attachments: []
				}];
				await itemSaver._saveToServer(items, () => {}, () => {});
				return captured;
			}
			finally {
				Zotero.API.createItem.restore();
			}
		});

		const savedItem = payload.items.find(item => item.itemType === 'book');
		assert.isOk(savedItem, 'Saved item passed to createItem');
		assert.deepEqual(savedItem.collections, ['AAAA']);
		assert.equal(payload.library.collectionKey, 'AAAA');
	});
});
