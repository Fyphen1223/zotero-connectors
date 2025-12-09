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

import { background } from '../support/utils.mjs';

describe('Zotero.API', function() {
	describe('createItem', function() {
		it('reauthorizes and retries when the server returns an auth error', async function() {
			const result = await background(async function() {
				const requestStub = sinon.stub(Zotero.HTTP, 'request');
				requestStub.onFirstCall().rejects(Object.assign(new Error('Forbidden'), { status: 403 }));
				requestStub.onSecondCall().resolves({ responseText: '{}' });
				
				const authorizeStub = sinon.stub(Zotero.API, 'authorize').resolves();
				const clearCredentialsSpy = sinon.spy(Zotero.API, 'clearCredentials');
				const getUserInfoStub = sinon.stub(Zotero.API, 'getUserInfo');
				getUserInfoStub.onFirstCall().resolves({
					'auth-token_secret': 'old-key',
					'auth-userID': '1'
				});
				getUserInfoStub.onSecondCall().resolves({
					'auth-token_secret': 'new-key',
					'auth-userID': '1'
				});
				
				try {
					await Zotero.API.createItem([{ foo: 'bar' }]);
					return {
						authorizeCalled: authorizeStub.calledOnce,
						clearCalled: clearCredentialsSpy.calledOnce,
						requestCalls: requestStub.callCount,
						secondRequestKey: requestStub.secondCall.args[2].headers['Zotero-API-Key']
					};
				}
				finally {
					requestStub.restore();
					authorizeStub.restore();
					clearCredentialsSpy.restore();
					getUserInfoStub.restore();
				}
			});
			
			assert.isTrue(result.authorizeCalled);
			assert.isTrue(result.clearCalled);
			assert.equal(result.requestCalls, 2);
			assert.equal(result.secondRequestKey, 'new-key');
		});
	});
});
