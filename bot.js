const WebSocket = require('ws');
const fs = require("fs");
const { Readable } = require("stream");
const { finished } = require("stream/promises");
const path = require("path");
const sharp = require("sharp");
const nsfwjs = require("nsfwjs");
const axios = require("axios"); //you can use any http client
const tf = require("@tensorflow/tfjs-node");
const { CHAT_CHANNEL_USER_ID, BOT_USER_ID, CLIENT_SECRET, CLIENT_ID, REWARD_ID, REFRESH_TOKEN, clientId, clientSecret, spotifyRefreshToken } = require("./config.json");

const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws';

let OAUTH_TOKEN;
let spotify_token;
var websocketSessionID;
var model;
let link = "none";
// Start executing the bot from here
(async () => {
	await getAuth();

	const websocketClient = startWebSocketClient();
})();


async function fn(url) {
	const pic = await axios.get(url, {
	  responseType: "arraybuffer",
	});
	// Image must be in tf.tensor3d format
	// you can convert image to tf.tensor3d with tf.node.decodeImage(Uint8Array,channels)
	const image = await tf.node.decodeImage(pic.data, 3);
	const predictions = await model.classify(image, 5);
	image.dispose(); 
	console.log(predictions);
	const verdict = Object.values(predictions[0]);
	if(verdict.includes("Drawing") || verdict.includes("Neutral")){
		return true;
	}
	return false;
  }

const downloadFile = async (url, eventID, username) => {
	let filename = eventID+username;
	const res = await fetch(url);
  
	const destination = path.resolve("./images", filename+".png");
	fs.unlink("./images/active.png", function (err) {
	  if (err && err.code == "ENOENT") {
		// file doens't exist
		console.log("File doesn't exist, won't remove it.");
	  } else if (err) {
		// other errors, e.g. maybe we don't have enough permission
		console.error("Error occurred while trying to remove file");
	  } else {
		console.log(`removed`);
	  }
	});
	const fileStream = fs.createWriteStream(destination, { flags: "wx" });
	await finished(Readable.fromWeb(res.body).pipe(fileStream));
	return "./images/"+filename+".png";
  };

  async function refreshSpotifyToken() { 
	const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    
    const config = {
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      }
    }
	const data = new URLSearchParams([
		['grant_type', 'refresh_token'],
		['refresh_token', spotifyRefreshToken]
		]).toString()

	const response = await axios.post("https://accounts.spotify.com/api/token", data, config)
	spotify_token = response.data.access_token;
	console.log("new spotify token "+spotify_token +" established");
}

async function refreshTwitchToken() { 
	const response = await axios({
		method: 'post',
		url: 'https://id.twitch.tv/oauth2/token',
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		params: {
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			grant_type: "refresh_token",
			refresh_token: REFRESH_TOKEN
		  },
	})
	OAUTH_TOKEN = response.data.access_token;
	console.log("new twitch token "+OAUTH_TOKEN+" established");
}

async function getAuth() {
	await refreshTwitchToken();
	await refreshSpotifyToken();
	let response = await fetch('https://id.twitch.tv/oauth2/validate', {
		method: 'GET',
		headers: {
			'Authorization': 'OAuth ' + OAUTH_TOKEN
		}
	});

	if (response.status != 200) {
		let data = await response.json();
		console.error("Token is not valid. /oauth2/validate returned status code " + response.status);
		console.error(data);
		process.exit(1);
	}

	console.log("Validated token.");
	model = await nsfwjs.load();
	console.log("Loaded nsfw model.");
}

function startWebSocketClient() {
	let websocketClient = new WebSocket(EVENTSUB_WEBSOCKET_URL);

	websocketClient.on('error', console.error);
	
	websocketClient.on('open', () => {
		console.log('WebSocket connection opened to ' + EVENTSUB_WEBSOCKET_URL);
	});

	websocketClient.on('message', (data) => {
		handleWebSocketMessage(JSON.parse(data.toString()));
	});

	return websocketClient;
}

async function handleWebSocketMessage(data) {
	switch (data.metadata.message_type) {
		case 'session_welcome': 
			websocketSessionID = data.payload.session.id; 

			registerEventSubListeners();
			registerChannelPointListener();
			break;
		case 'notification':
			switch (data.metadata.subscription_type) {
				case 'channel.chat.message':
					let msg = data.payload.event.message.text.trim();
					console.log(`MSG #${data.payload.event.broadcaster_user_login} ${msg}`);
						if(msg === "!playlist"){
						const response = await axios({
							method: 'get',
							url: 'https://api.spotify.com/v1/me/player/currently-playing',
							headers: {
								Authorization: `Bearer `+spotify_token,
							  },
						  });
						let playlistLink = response.data.context.external_urls.spotify;
						sendChatMessage("current playlist: "+playlistLink);
						break;
						}
						if(msg === "aeiou"){
							sendChatMessage("hey man");
						break;
						}
					break;

				case 'channel.channel_points_custom_reward_redemption.add':
				link = data.payload.event.user_input
				console.log(`MSG #${data.payload.event.broadcaster_user_login} ${link}`);
				if (!link.startsWith(`https://cdn.discordapp.com/attachments/`)){
					sendChatMessage("@"+data.payload.event.user_name+", link needs to start with https://cdn.discordapp.com/attachments/");
					break;
				} 
				console.log("downloading image...");
				const validate = await fn(link);
				if(validate){
				const filelink = await downloadFile(link, data.payload.event.id, data.payload.event.chatter_user_login);
				lastlink = link;	
				console.log("image downloaded");
				await sharp(filelink)
				.resize({width: 250, height: 486, fit: sharp.fit.fill})
				.jpeg({ quality: 70 })
				.flatten({ background: '#0a1908' })
				.toFile(`./images/active.png`);
				sendChatMessage("livesplit background successfully downloaded!");
				}
				else {
					sendChatMessage("image is too explicit! download failed.");
				}
				break;
			}
			break;
	}
}

async function sendChatMessage(chatMessage) {
	let response = await fetch('https://api.twitch.tv/helix/chat/messages', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			broadcaster_id: CHAT_CHANNEL_USER_ID,
			sender_id: BOT_USER_ID,
			message: chatMessage
		})
	});

	if (response.status != 200) {
		let data = await response.json();
		console.error("Failed to send chat message");
		console.error(data);
	} else {
		console.log("Sent chat message: " + chatMessage);
	}
}

async function registerChannelPointListener() {
	let response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			type: 'channel.channel_points_custom_reward_redemption.add',
			version: '1',
			condition: {
				broadcaster_user_id: CHAT_CHANNEL_USER_ID,
				reward_id: REWARD_ID
			},
			transport: {
				method: 'websocket',
				session_id: websocketSessionID
			}
		})
	});

	if (response.status != 202) {
		let data = await response.json();
		console.error("Failed to subscribe to channel.channel_points_custom_reward_redemption.add. API call returned status code " + response.status);
		console.error(data);
		process.exit(1);
	} else {
		const data = await response.json();
		console.log(`Subscribed to channel.channel_points_custom_reward_redemption.add [${data.data[0].id}]`);
	}

}

async function registerEventSubListeners() {
	// Register channel.chat.message
	let response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			type: 'channel.chat.message',
			version: '1',
			condition: {
				broadcaster_user_id: CHAT_CHANNEL_USER_ID,
				user_id: BOT_USER_ID
			},
			transport: {
				method: 'websocket',
				session_id: websocketSessionID
			}
		})
	});

	if (response.status != 202) {
		let data = await response.json();
		console.error("Failed to subscribe to channel.chat.message. API call returned status code " + response.status);
		console.error(data);
		process.exit(1);
	} else {
		const data = await response.json();
		console.log(`Subscribed to channel.chat.message [${data.data[0].id}]`);
	}

}

setInterval(async () => {
	refreshSpotifyToken();
	refreshTwitchToken();
}, (3590000));