# Bluesky Bookmarks Webapp

A modern web application to view your Bluesky bookmarks. Since Bluesky doesn't have native bookmark functionality yet, this app finds posts you've "bookmarked" by replying to them with a 📌 emoji.

![Bluesky Bookmarks](https://img.shields.io/badge/Built%20with-Claude%20Sonnet%204-blue)
![License](https://img.shields.io/badge/License-MIT-green)
![React](https://img.shields.io/badge/React-18-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)

## ✨ Features

- 🔐 **OAuth Authentication** - Secure login with your Bluesky account
- 📌 **Bookmark Discovery** - Automatically finds posts you've bookmarked with 📌 emoji
- 🔍 **Search & Filter** - Search through your bookmarks by content or author
- 📱 **Responsive Design** - Works beautifully on desktop and mobile
- 🚀 **Fast & Lightweight** - Built with modern React and Vite
- 🌐 **Easy Self-Hosting** - Simple deployment with comprehensive documentation

## 🛠️ How It Works

1. **Bookmark Posts**: Reply to any Bluesky post with the 📌 emoji to bookmark it
2. **Login**: Sign in with your Bluesky handle using OAuth
3. **View Bookmarks**: The app searches for your 📌 replies and displays the original posts
4. **Search**: Filter your bookmarks by text content, author, or handle

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/bluesky-bookmarks-webapp.git
   cd bluesky-bookmarks-webapp
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Open your browser**
   Navigate to `http://localhost:5173`

### Building for Production

```bash
npm run build
npm run preview
```

## 🌐 Deployment

### Vercel (Recommended)

1. Fork this repository
2. Connect your GitHub account to [Vercel](https://vercel.com)
3. Import your forked repository
4. Deploy with default settings

### Netlify

1. Fork this repository
2. Connect your GitHub account to [Netlify](https://netlify.com)
3. Import your forked repository
4. Build command: `npm run build`
5. Publish directory: `dist`

### Self-Hosting

```bash
# Build the app
npm run build

# Serve the dist folder with any static file server
# For example, using Python:
cd dist
python -m http.server 8000

# Or using Node.js serve:
npx serve dist
```

## 🔧 Configuration

### OAuth Client ID

For production deployment, update the `clientId` in `src/services/auth.ts`:

```typescript
private readonly clientId = 'https://your-domain.com';
```

The client ID should match your deployed domain for OAuth to work correctly.

### API Endpoints

The app uses the following APIs:

- **Bluesky AppView**: `https://public.api.bsky.app` (for author feed, post details, and search)
- **AT Protocol**: For OAuth authentication and handle resolution

## 📖 API Documentation

This app integrates with several APIs:

### Bluesky AppView APIs
Uses public AppView endpoints like `app.bsky.feed.getAuthorFeed` and `app.bsky.feed.getPosts` to discover and render bookmarks.

### AT Protocol OAuth
Implements the [AT Protocol OAuth specification](https://atproto.com/specs/oauth.html) for secure user authentication.

## 🔒 Privacy & Security

- **No Data Storage**: Your bookmarks are fetched directly from Bluesky's APIs
- **Secure Authentication**: Uses OAuth 2.0 with PKCE for secure login
- **Session Management**: Tokens are stored locally and never sent to third parties
- **Read-Only Access**: Only requests read permissions for your public posts

## 🛠️ Development

### Project Structure

```
src/
├── components/          # React components
│   ├── Login.tsx       # Login form with OAuth
│   ├── Bookmarks.tsx   # Main bookmarks display
│   ├── PostCard.tsx    # Individual post component
│   └── AuthCallback.tsx # OAuth callback handler
├── services/           # API services
│   ├── auth.ts         # AT Protocol OAuth
│   ├── bluesky.ts      # Bluesky API integration (author feed, posts, search)
├── types.ts            # TypeScript definitions
└── App.tsx             # Main app component
```

### Tech Stack

- **Frontend**: React 18 + TypeScript
- **Styling**: Tailwind CSS
- **Build Tool**: Vite
- **Routing**: React Router
- **Icons**: Lucide React
- **HTTP Client**: Axios

### Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **[AT Protocol](https://atproto.com/)** - The decentralized social networking protocol
- **[Bluesky](https://bsky.social/)** - The decentralized social network
- **[Claude Sonnet 4](https://anthropic.com/)** - AI assistant that helped write this application

## 🐛 Issues & Support

If you encounter any issues or have questions:

1. Check the [Issues](https://github.com/yourusername/bluesky-bookmarks-webapp/issues) page
2. Create a new issue with detailed information
3. Include browser, OS, and any error messages

## 🔮 Roadmap

- [ ] Export bookmarks to various formats (JSON, CSV, HTML)
- [ ] Bookmark categories and tags
- [ ] Bulk bookmark management
- [ ] Dark mode support
- [ ] Progressive Web App (PWA) features
- [ ] Bookmark statistics and analytics

---

**Built with ❤️ and Claude Sonnet 4**
