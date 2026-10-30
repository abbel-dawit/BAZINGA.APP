// Privacy Policy & Terms of Use. Bump TERMS_VERSION whenever the text changes —
// every user will then be asked to accept again.
export const TERMS_VERSION = '2026-10-30.2';
export const OWNER = 'Abbel Dawit';

export const LEGAL_HTML = `
<p class="tiny muted">Last updated: 30 October 2026 · Version ${TERMS_VERSION}</p>

<h3>Terms of Use</h3>
<p>BAZINGA! ("the App") is a free, personal project made available by ${OWNER} ("we", "us"). By creating a profile or otherwise using the App you agree to these Terms and the Privacy Policy below. If you do not agree, do not use the App.</p>

<h4>1. What the App is</h4>
<p>The App is a tool that runs entirely in your web browser. It helps you organise music you already have access to, look up matching videos on YouTube, and play them through YouTube's official embedded player or from files stored on your own device. The App does not host, sell, stream from its own servers, or distribute any music or video.</p>

<h4>2. Not affiliated</h4>
<p>The App is independent and is not affiliated with, endorsed by or sponsored by Spotify, YouTube, Google, Apple, or any artist, label or rights holder. All trademarks, names and artwork belong to their respective owners.</p>

<h4>3. Your responsibilities</h4>
<ul>
<li>You must be at least 13 years old (or the minimum age required where you live) to use the App.</li>
<li>You are solely responsible for how you use the App and for any content you import, add, play or share, including making sure you have the right to use any music files you add to the App.</li>
<li>You must follow the terms of every third-party service you use through the App, including YouTube's Terms of Service, Spotify's Developer and User Terms, and Apple's terms.</li>
<li>Lyrics are shown through Genius's own embed and remain the property of their rights holders; you may only use them for personal viewing.</li>
<li>You must not use the App for anything unlawful, to infringe anyone's rights, or to attempt to download or copy content from YouTube or other services.</li>
<li>You are responsible for keeping your own backups. Data stored in a browser can be lost (for example if browser data is cleared or a device is lost).</li>
</ul>

<h4>4. Third-party services</h4>
<p>The App connects directly from your device to third-party services (listed in the Privacy Policy). We do not control those services and are not responsible for their availability, accuracy, content, matching results, or how they handle your data. Search results and video matches are produced automatically and may be wrong, unavailable or removed at any time.</p>

<h4>5. No warranty</h4>
<p>THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE", FREE OF CHARGE, WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, AVAILABILITY, SECURITY, OR THAT IT WILL BE ERROR-FREE OR THAT DATA WILL NOT BE LOST.</p>

<h4>6. Limitation of liability</h4>
<p>TO THE FULLEST EXTENT PERMITTED BY LAW, ${OWNER.toUpperCase()} AND ANY CONTRIBUTORS TO BAZINGA! SHALL NOT BE LIABLE FOR ANY CLAIM, LOSS OR DAMAGE OF ANY KIND — INCLUDING DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, LOSS OF DATA, LOSS OF PROFITS, DEVICE PROBLEMS, DATA CHARGES, OR CLAIMS BY THIRD PARTIES (INCLUDING COPYRIGHT CLAIMS) — ARISING OUT OF OR RELATED TO YOUR USE OF, OR INABILITY TO USE, THE APP OR ANY THIRD-PARTY SERVICE OR CONTENT ACCESSED THROUGH IT, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. YOU USE THE APP ENTIRELY AT YOUR OWN RISK.</p>
<p>Some jurisdictions do not allow certain warranties or liabilities to be excluded. In those places, the exclusions above apply to the maximum extent the law allows.</p>

<h4>7. Indemnity</h4>
<p>You agree to defend, indemnify and hold harmless ${OWNER} and any contributors from any claims, damages, costs and expenses (including reasonable legal fees) arising from your use of the App, your content, or your breach of these Terms or of any third party's rights or terms.</p>

<h4>8. Changes and ending use</h4>
<p>We may change, suspend or discontinue the App, or update these Terms, at any time without notice. If the Terms change, the App will ask you to accept the new version before continuing. You can stop using the App at any time and delete all its data from Settings.</p>

<h4>9. General</h4>
<p>If any part of these Terms is found unenforceable, the rest remains in effect. These Terms are the entire agreement between you and us about the App.</p>

<h3>Privacy Policy</h3>
<h4>What we collect</h4>
<p><b>There are no accounts, no sign-in and no analytics.</b> We never ask for your name, email or password, and there is no advertising.</p>
<p><b>If you turn on device sync</b> (optional, Settings → Sync your devices), your device makes a random sync key and encrypts a copy of your music library (songs, likes, playlists, albums, YouTube matches, your display name and picture, and app settings, but never your API keys, tokens or offline music files) <b>before</b> it leaves the device. The encrypted copy is passed between your devices through ntfy.sh, a free public relay service, under a topic name derived from the key, together with a short device label such as "Safari on iPhone". Copies there expire after about 3 hours. Neither we nor ntfy.sh receive the key itself, so nobody else can read your library. If you create an 8-character short code, your sync key is posted to the relay encrypted with that code, and the app only accepts it for 15 minutes. Anyone you give your sync link, QR code or short code to can see and change your synced library, so share them only with your own devices. You can stop syncing at any time in <b>Settings → Sync your devices</b>.</p>

<h4>What is stored on your device</h4>
<p>Your display name, profile picture, library, playlists, albums, YouTube matches, settings, any music files you add, any Spotify sign-in token, and automatic backups are stored only in your browser's storage on your device (and in any backup file you choose to save). You can erase all of it at any time with <b>Settings → Erase this device</b>.</p>

<h4>Third-party services your device talks to</h4>
<p>To work, the App sends requests directly from your device to these services, which receive your IP address and the search terms or IDs needed. Their own privacy policies apply:</p>
<ul>
<li><b>YouTube / Google</b> — to show and play videos with the official YouTube player, and, if you add your own API key, to search YouTube.</li>
<li><b>Public Invidious and Piped servers</b> (independent, community-run) — to search for matching YouTube videos without an API key.</li>
<li><b>Apple iTunes Search API</b> — to look up genres, release dates, artwork, albums, artists and new releases.</li>
<li><b>Deezer API</b> — to find missing cover art and artist photos.</li>
<li><b>Genius</b> — only when you open lyrics: to find the song and show Genius's official lyrics widget (and, if you add one, using your own Genius access token).</li>
<li><b>Spotify</b> — only if you choose to connect it, to read your Liked Songs and playlists.</li>
<li><b>ntfy.sh</b> — only if you turn on device sync: relays the encrypted copy of your library between your devices (<a href="https://docs.ntfy.sh/privacy/" target="_blank" rel="noopener">ntfy.sh privacy policy</a>).</li>
<li><b>Google / YouTube account</b> — only if you choose to connect it (see below).</li>
<li><b>Buy Me a Coffee</b> — only if you choose to send a tip; payments happen on their site and BAZINGA! never sees your payment details.</li>
<li><b>Google Fonts</b> and <b>GitHub Pages</b> — to load the App's fonts and files.</li>
</ul>

<h4>YouTube account connection</h4>
<p>If you connect your YouTube account, BAZINGA! uses Google's sign-in to ask for permission to manage your YouTube playlists. It uses that permission <b>only</b> to (a) list your playlists and their videos when you choose to import them, and (b) create playlists and add videos to them when you choose "Save to YouTube". It never deletes anything, never uploads videos, never posts comments, and never reads anything else from your account. The access token Google issues is stored only on your device, expires after about an hour, and is never sent to us — we have no server. You can disconnect in Settings at any time, and revoke access completely at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>.</p>
<p>BAZINGA! uses YouTube API Services. By using these features you agree to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube Terms of Service</a>, and Google's handling of your data is described in the <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a>.</p>

<h4>Voice assistant</h4>
<p>The voice assistant only listens after you tap the microphone, and stops after one request. Speech recognition is provided by your browser or operating system (for example Google in Chrome, Apple in Safari, Microsoft in Edge), which may process your voice on their servers under their own privacy policies. BAZINGA! itself never records, stores or sends your voice anywhere. If you prefer, you can type requests instead.</p>

<h4>Sharing</h4>
<p>When you share a song, playlist or album, its song list (and your username) is packed into the link itself. Anyone you give the link to can read it. Nothing is uploaded by the App.</p>

<h4>Children</h4>
<p>The App is not directed at children under 13.</p>

<h4>Contact</h4>
<p>Questions about these terms can be raised through the App's public GitHub repository.</p>
`;
