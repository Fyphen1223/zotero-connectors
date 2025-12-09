/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2011 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
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

Zotero.API = new function() {
	var _tokenSecret;
	var config = ZOTERO_CONFIG;
	let _serverLibraryTargetsPromise;
	
	function _getLibraryPath(library, userInfo) {
		if (!library) {
			return `users/${userInfo['auth-userID']}`;
		}
		
		let libraryType = library.libraryType || library.type || 'user';
		let libraryID = library.libraryID || library.id || library.groupID || library.userID;
		
		// Strip the 'L' prefix used in the progress window when it reaches the API layer
		if (typeof libraryID === 'string' && libraryID.startsWith('L')) {
			// Format from progress window: Luser-123 or Lgroup-456
			let parts = libraryID.slice(1).split('-');
			if (parts.length === 2) {
				libraryType = parts[0] === 'group' ? 'group' : 'user';
				libraryID = parts[1];
			} else {
				Zotero.debug(`Unexpected library id format "${libraryID}", defaulting to user library`);
				libraryID = libraryID.slice(1);
			}
		}
		
		let prefix = libraryType === 'group' ? 'groups' : 'users';
		return `${prefix}/${libraryID}`;
	}
	
	/**
	 * Decodes application/x-www-form-urlencoded data
	 */
	function _decodeFormData(postData) {
		var splitData = postData.split("&");
		var decodedData = {};
		for(var i in splitData) {
			var variable = splitData[i];
			var splitIndex = variable.indexOf("=");
			decodedData[decodeURIComponent(variable.substr(0, splitIndex))] =
				decodeURIComponent(variable.substr(splitIndex+1).replace(/\+/g, "%20"));
		}
		return decodedData;
	}
	
	/**
	 * Performs OAuth authorization
	 */
	this.authorize = async function() {
		if (this._deferred) {
			if (this._authWindow) {
				Zotero.Connector_Browser.bringToFront(false, this._authWindow.tabs[0]);
			}
			return this._deferred.promise;
		}
		this._deferred = Zotero.Promise.defer();
		this._deferred.promise
			.then((r) => {this._deferred = null}, (e) => {this._deferred = null});
		
		var oauthSimple = new OAuthSimple(config.OAUTH.ZOTERO.CLIENT_KEY,
			config.OAUTH.ZOTERO.CLIENT_SECRET);
		oauthSimple.setURL(config.OAUTH.ZOTERO.REQUEST_URL);
		oauthSimple.setAction("POST");
		
		let options = {
			body: '',
			headers: {"Authorization": oauthSimple.getHeaderString()}
		};
		try {
			let xmlhttp = await Zotero.HTTP.request("POST", config.OAUTH.ZOTERO.REQUEST_URL, options)
			// parse output and store token_secret
			var data = _decodeFormData(xmlhttp.responseText);
			_tokenSecret = data.oauth_token_secret;
			
			// get signed URL
			oauthSimple.signatures(data);
			oauthSimple.setURL(config.OAUTH.ZOTERO.AUTHORIZE_URL);
			var signature = oauthSimple.sign();
			
			// add parameters
			var url = signature.signed_url+"&library_access=1&notes_access=0&write_access=1&name=Zotero Connector for ";
			if (Zotero.isChrome) {
				url += "Chrome";
			} else if(Zotero.isSafari) {
				url += "Safari";
			} else if (Zotero.isFirefox) {
				url += "Firefox";
			} else if (Zotero.isEdge) {
				url += "Edge";
			}
			
			this._authWindow = await Zotero.Connector_Browser.openWindow(url, {width: 900, height: 600, type: 'normal',
				onClose: Zotero.API.onAuthorizationCancel.bind(Zotero.API)});
		}		
		catch (e) {
			Zotero.logError(`OAuth request failed with ${e.status}; response was ${e.responseText}`);
			this._deferred.reject(new Error("An invalid response was received from the Zotero server"));
		}
		return this._deferred.promise;
	};
	
	/**
	 * Called when OAuth is complete
	 * @param {String} data The query string received from OAuth
	 * @param {Tab} tab The object corresponding to the tab where OAuth completed
	 */
	this.onAuthorizationComplete = async function(data, tab) {
		// close auth window
		// ensure that tab close listeners don't have a promise they can reject
		// this is kinda awful.
		let deferred = this._deferred;
		this._deferred = null;
		if(Zotero.isBrowserExt) {
			browser.tabs.remove(tab.id);
		} else if (Zotero.isSafari) {
			Zotero.Connector_Browser.closeTab(tab);
		}
		
		if(!_tokenSecret) {
			throw new Error("onAuthenticationComplete called with no outstanding OAuth request");
		}
		
		var oauthSimple = new OAuthSimple(config.OAUTH.ZOTERO.CLIENT_KEY,
			config.OAUTH.ZOTERO.CLIENT_SECRET);
		oauthSimple.setURL(config.OAUTH.ZOTERO.ACCESS_URL);
		oauthSimple.setParameters(_decodeFormData(data));
		oauthSimple.signatures({oauth_token_secret: _tokenSecret});
		oauthSimple.setAction("POST");
		_tokenSecret = undefined;

		let options = {
			body: '',
			headers: {"Authorization": oauthSimple.getHeaderString()}
		};
		try {
			var xmlhttp = await Zotero.HTTP.request("POST", config.OAUTH.ZOTERO.ACCESS_URL, options)
		}
		catch(e) {
			Zotero.logError(`OAuth access failed with ${e.status}; response was ${e.responseText}`);
			return deferred.reject(new Error("An invalid response was received from the Zotero server"));
		}
		data = _decodeFormData(xmlhttp.responseText);

		let keysUrl = config.API_URL + "users/" + data.userID + "/keys/current";
		xmlhttp = await Zotero.HTTP.request("GET", keysUrl, {
			headers: {
				"Zotero-API-Key": data.oauth_token_secret,
				"Zotero-API-Version": "3"
			}
		});
		try {
			var json = JSON.parse(xmlhttp.responseText),
				access = json.access;
		} catch(e) {};
		
		let responseText = xmlhttp.responseText.replace(data.oauth_token_secret, '[API_KEY_HIDDEN]');

		if(!access || !access.user) {
			Zotero.logError("Key verification failed with "+xmlhttp.status+'; response was '+responseText);
			Zotero.logError("Key verification failed with "+xmlhttp.status+'; response was '+xmlhttp.responseText);
			return deferred.reject(new Error("API key could not be verified"));
		}
		
		if(!access.user.library || !access.user.write) {
			Zotero.logError("Generated key had inadequate permissions; response was "+responseText);
			return deferred.reject(new Error("The key you have generated does not have adequate "+
				"permissions to save items to your Zotero library. Please try again "+
				"without modifying your key's permissions."));
		}
	
		Zotero.Prefs.set('auth-token', data.oauth_token);
		Zotero.Prefs.set('auth-token_secret', data.oauth_token_secret);
		Zotero.Prefs.set('auth-userID', data.userID);
		Zotero.Prefs.set('auth-username', data.username);
		
		return deferred.resolve({"auth-username": data.username, "auth-userID": data.userID});
	};
	
	this.onAuthorizationCancel = function() {
		if (this._deferred) {
			this._deferred.reject(new Error('Authorization cancelled.'));
		}
	};
	
	/**
	 * Clears OAuth credentials from storage
	 */
	this.clearCredentials = function() {
		let keys = ['auth-token', 'auth-token_secret', 'auth-userID', 'auth-username'];
		Zotero.Prefs.clear(keys);
		// TODO revoke key
	};
	
	/**
	 * Gets authorized username
	 * @param {Function} callback Callback to receive username (or null if none is define)
	 */
	this.getUserInfo = async function() {
		let keys = ['auth-token_secret', 'auth-userID', 'auth-username'];
		return Zotero.Prefs.getAsync(keys).catch(function() {
			return null;
		});
	};
	
	this.setServerLibraryTarget = function(target) {
		if (!target) return;
		let prefValue = target.id || `${target.libraryType}:${target.libraryID}`;
		Zotero.Prefs.set('server.lastLibraryTarget', prefValue);
		if (_serverLibraryTargetsPromise) {
			_serverLibraryTargetsPromise = _serverLibraryTargetsPromise.then((data) => {
				if (!data) return data;
				return Object.assign({}, data, { target });
			});
		}
	};
	
	/**
	 * Fetch available libraries (user + groups) for save-to-server mode.
	 * Returns { target, targets } where target is the preferred/default library row.
	 */
	this.getServerLibraryTargets = async function(force=false) {
		if (_serverLibraryTargetsPromise && !force) {
			return _serverLibraryTargetsPromise;
		}
		
		_serverLibraryTargetsPromise = (async () => {
			const userInfo = await this.getUserInfo();
			if (!userInfo) return null;
			
			const headers = {
				"Zotero-API-Key": userInfo['auth-token_secret'],
				"Zotero-API-Version": "3",
			};
			
			const fetchAllPages = async (url) => {
				const results = [];
				let start = 0;
				const limit = 100;
				while (true) {
					const pageUrl = `${url}${url.includes('?') ? '&' : '?'}limit=${limit}&start=${start}`;
					let xhr;
					try {
						xhr = await Zotero.HTTP.request("GET", pageUrl, { headers });
					}
					catch (e) {
						Zotero.logError(e);
						break;
					}
					let data;
					try {
						data = JSON.parse(xhr.responseText);
					}
					catch (e) {
						Zotero.logError(e);
						break;
					}
					if (!Array.isArray(data) || !data.length) break;
					results.push(...data);
					
					const totalResultsHeader = xhr.getResponseHeader && xhr.getResponseHeader('Total-Results');
					const totalResults = totalResultsHeader ? parseInt(totalResultsHeader, 10) : null;
					const hasTotal = Number.isFinite(totalResults);
					start += data.length;
					if (data.length < limit) break;
					if (hasTotal && start >= totalResults) break;
				}
				return results;
			};
			
			const buildCollectionRows = (libraryRow, collections=[]) => {
				const rows = [];
				const byParent = new Map();
				for (let col of collections) {
					let data = col.data || col;
					let key = data.key || data.id || data.collectionKey;
					if (!key) continue;
					let parent = data.parentCollection || false;
					if (!byParent.has(parent)) {
						byParent.set(parent, []);
					}
					byParent.get(parent).push({
						key,
						name: data.name || `Collection ${key}`,
						parent
					});
				}
				
				const addChildren = (parentKey, level) => {
					let children = byParent.get(parentKey) || [];
					children.sort((a, b) => a.name.localeCompare(b.name));
					for (let child of children) {
						rows.push({
							id: `C${libraryRow.libraryType}-${libraryRow.libraryID}-${child.key}`,
							name: child.name,
							level,
							libraryType: libraryRow.libraryType,
							libraryID: libraryRow.libraryID,
							collectionKey: child.key,
							filesEditable: libraryRow.filesEditable,
							libraryEditable: libraryRow.libraryEditable
						});
						addChildren(child.key, level + 1);
					}
				};
				
				addChildren(false, libraryRow.level + 1);
				return rows;
			};
			
			const fetchCollectionsForLibrary = async (libraryRow) => {
				let path = _getLibraryPath({
					libraryType: libraryRow.libraryType,
					libraryID: libraryRow.libraryID
				}, userInfo);
				let url = `${config.API_URL}${path}/collections`;
				return fetchAllPages(url);
			};
			
			const fetchTagsForLibrary = async (libraryRow) => {
				let path = _getLibraryPath({
					libraryType: libraryRow.libraryType,
					libraryID: libraryRow.libraryID
				}, userInfo);
				let url = `${config.API_URL}${path}/tags`;
				let rawTags = await fetchAllPages(url);
				let tags = rawTags.map(tag => tag.tag || tag.name || tag).filter(Boolean);
				return [...new Set(tags)];
			};
			
			let userLibraryRow = {
				id: `Luser-${userInfo['auth-userID']}`,
				name: "My Library",
				level: 0,
				libraryType: 'user',
				libraryID: userInfo['auth-userID'],
				filesEditable: true,
				libraryEditable: true
			};
			let targets = [userLibraryRow];
			let tags = {};
			
			try {
				let userCollections = await fetchCollectionsForLibrary(userLibraryRow);
				targets = targets.concat(buildCollectionRows(userLibraryRow, userCollections));
				tags[userLibraryRow.id] = await fetchTagsForLibrary(userLibraryRow);
			}
			catch (e) {
				Zotero.logError(e);
			}
			
			try {
				let url = `${config.API_URL}users/${userInfo['auth-userID']}/groups`;
				let xhr = await Zotero.HTTP.request("GET", url, {
					headers: {
						"Zotero-API-Key": userInfo['auth-token_secret'],
						"Zotero-API-Version": "3",
					}
				});
					let groups = JSON.parse(xhr.responseText);
					for (let group of groups) {
						let data = group.data || group;
						let groupID = data.id || data.groupID || data.group;
						let filesEditable = data.fileEditing ? data.fileEditing !== 'none' : true;
						let libraryEditable = data.libraryEditing ? data.libraryEditing !== 'none' : true;
					let libraryRow = {
						id: `Lgroup-${groupID}`,
						name: data.name || `Group ${groupID}`,
						level: 0,
						libraryType: 'group',
						libraryID: groupID,
						filesEditable,
						libraryEditable
					};
					targets.push(libraryRow);
					try {
						let collections = await fetchCollectionsForLibrary(libraryRow);
						targets = targets.concat(buildCollectionRows(libraryRow, collections));
						tags[libraryRow.id] = await fetchTagsForLibrary(libraryRow);
					}
					catch (e) {
						Zotero.logError(e);
					}
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
			
			let preferred = Zotero.Prefs.get('server.lastLibraryTarget');
			let target = targets.find(t => t.id == preferred
				|| `${t.libraryType}:${t.libraryID}` == preferred);
			if (!target) {
				target = targets[0];
			}
			return { target, targets, tags };
		})();
		return _serverLibraryTargetsPromise;
	};
	
	/**
	 * Creates a new item. In Safari, this runs in the background script. In Chrome, it
	 * runs in the injected script.
	 * @param {Object} payload Item(s) to create, in the object format expected by the server.
	 * @param {String|null} itemKey Parent item key, or null if a top-level item.
	 * @param {Boolean} [askForAuth] If askForAuth === false, don't ask for authorization if not 
	 *     already authorized.
	 * @param {Object} [library] Library descriptor { libraryType, libraryID }
	 */
	this.createItem = async function(payload, askForAuth, library) {
		var userInfo = await Zotero.API.getUserInfo();
		if(!userInfo) {
			if(askForAuth === false) {
				throw new Error("Not authorized");
			}
			return Zotero.API.authorize().then(function() {
				return Zotero.API.createItem(payload, false, library);
			}, function(e) {
				e.message = `Authentication failed: ${e.message}`;
				throw e;
			})
		}
		
		var url = config.API_URL + _getLibraryPath(library, userInfo) + "/items";
		var options = {
			body: JSON.stringify(payload),
			headers: {
				"Content-Type": "application/json",
				"Zotero-API-Key": userInfo['auth-token_secret'],
				"Zotero-API-Version": "3"
			}
		};
		try {
			var xhr = await Zotero.HTTP.request("POST", url, options);
			return xhr.responseText;
		}
		catch(e) {
			if (askForAuth && e.status === 403) {
				return Zotero.API.createItem(payload, true, library);
			}
			Zotero.logError(e);
			throw e;
		};
	};
	
	/**
	 * Uploads an attachment to the Zotero server.
	 * @param {Object} attachment An attachment object. This object must have the following keys<br>
	 *     data - the attachment contents, as a typed array<br>
	 *     filename - a filename for the attachment<br>
	 *     key - the attachment item key<br>
	 *     md5 - the MD5 hash of the attachment contents<br>
	 *     mimeType - the attachment MIME type
	 */
	this.uploadAttachment = async function(attachment, library) {
		const REQUIRED_PROPERTIES = ["data", "key", "md5", "mimeType"];
		for (const property of REQUIRED_PROPERTIES) {
			if (!attachment[property]) {
				throw new Error('Required property "' + property + '" not defined');
			}
		}
		
		if (/[^a-zA-Z0-9]/.test(attachment.key)) {
			throw new Error('Attachment key is invalid');
		}
		
		var data = {
			"md5":attachment.md5,
			"filename":attachment.filename,
			"filesize":attachment.data.byteLength,
			"mtime":(+new Date),
			"contentType":attachment.mimeType
		};
		if (attachment.charset) data.charset = attachment.charset;
		var dataString = [];
		for (const [key, value] of Object.entries(data)) {
			dataString.push(`${key}=${encodeURIComponent(value)}`);
		}
		data = dataString.join("&");
		
		const userInfo = await Zotero.API.getUserInfo()
		if (!userInfo) {
			// We should always have authorization credentials, since an item needs to
			// be created before we can upload data. Thus, this code is probably
			// unreachable, but it's here just in case.
			throw new Error("No authorization credentials available");
		}
		
		const url = config.API_URL + _getLibraryPath(library, userInfo) + "/items/" + attachment.key + "/file";
		let options = {
			body: data,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"If-None-Match": "*",
				"Zotero-API-Key": userInfo['auth-token_secret'],
				"Zotero-API-Version": "3"
			}
		};
		let xhr = await Zotero.HTTP.request("POST", url, options);
		try {
			var response = JSON.parse(xhr.responseText);
		} catch(e) {
			throw new Error("Error parsing JSON from server");
		}
		
		// { "exists": 1 } implies no further action necessary
		if (response.exists) {
			Zotero.debug("OAuth: Attachment exists; no upload necessary");
			return attachment;
		}
		
		Zotero.debug("OAuth: Upload authorized");
		
		// Append prefix and suffix to data array
		var prefixLength = Zotero.Utilities.getStringByteLength(response.prefix),
			suffixLength = Zotero.Utilities.getStringByteLength(response.suffix),
			uploadData = new Uint8Array(attachment.data.byteLength + prefixLength
				+ suffixLength);
		Zotero.Utilities.stringToUTF8Array(response.prefix, uploadData, 0);
		uploadData.set(new Uint8Array(attachment.data), prefixLength);
		Zotero.Utilities.stringToUTF8Array(response.suffix, uploadData,
			attachment.data.byteLength+prefixLength);
		
		await Zotero.HTTP.request("POST", response.url, {
			headers: {
				"Zotero-API-Key": userInfo['auth-token_secret'],
				"Zotero-API-Version": "3",
				"Content-Type": response.contentType
			},
			body: uploadData.buffer
		})
		// Upload complete; register it
		options = {
			body: `upload=${response.uploadKey}`,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"If-None-Match": "*",
				"Zotero-API-Key": userInfo['auth-token_secret'],
				"Zotero-API-Version": "3"
			},
			successCodes: false
		};
		await Zotero.HTTP.request("POST", url, options);
		Zotero.debug("Zotero API: Upload registered");
		return attachment;
	};
}
