# API Authentication Setup Guide

## 🚨 401 Authentication Error Fix

This guide will help you resolve the "API error: 401" authentication issues in your AI Medical Research Panel.

## Quick Fix Steps

### 1. Create Environment File
Copy the provided `.env` file to your project root:
```bash
cp .env.example .env
```

### 2. Configure API Keys
Edit the `.env` file and add your actual API keys:

```env
# Default OpenAI Configuration (fallback)
VITE_API_URL=https://api.openai.com/v1/chat/completions
VITE_API_KEY=<your-api-key>

# APIPlus Configuration (Primary Provider)
VITE_API_URL_APIPLUS=<API_BASE_URL>
VITE_API_KEY_APIPLUS=<your-api-key>
VITE_API_KEY_APIPLUS_CLAUDE=<your-api-key>

# Moonshot Configuration (Kimi models)
VITE_API_URL_MOONSHOT=https://api.moonshot.cn/v1/chat/completions
VITE_API_KEY_MOONSHOT=<your-api-key>
```

### 3. Validate Configuration
Run the diagnostics by opening your browser console when starting the app. The system will automatically log API configuration status.

## Provider-Specific Setup

### APIPlus (Recommended)
1. Sign up at [APIPlus](<API_BASE_URL>
2. Generate API keys for different models
3. Set `VITE_API_KEY_APIPLUS` for GPT models
4. Set `VITE_API_KEY_APIPLUS_CLAUDE` for Claude models

### Moonshot (Kimi Models)
1. Register at [Moonshot](https://platform.moonshot.cn)
2. Create API key
3. Set `VITE_API_KEY_MOONSHOT`

### OpenAI (Fallback)
1. Get API key from [OpenAI](https://platform.openai.com)
2. Set `VITE_API_KEY`

## Model Configuration Matrix

| Model | Provider | API Key Env Var | Base URL Env Var |
|-------|----------|-----------------|------------------|
| GPT-5 | APIPlus | VITE_API_KEY_APIPLUS | VITE_API_URL_APIPLUS |
| Claude Sonnet 4.5 | APIPlus | VITE_API_KEY_APIPLUS_CLAUDE | VITE_API_URL_APIPLUS |
| Gemini 2.5 Pro | APIPlus | VITE_API_KEY_APIPLUS | VITE_API_URL_APIPLUS |
| Kimi K2 | Moonshot | VITE_API_KEY_MOONSHOT | VITE_API_URL_MOONSHOT |
| Qwen3 Max | APIPlus | VITE_API_KEY_APIPLUS | VITE_API_URL_APIPLUS |

## Common Issues and Solutions

### Issue: "Authentication failed for [model]. Please check your API key configuration."
**Solution**:
- Verify the API key is correctly set in your `.env` file
- Check for typos in environment variable names
- Ensure the API key has access to the specific model

### Issue: "API key not found for model [modelId]"
**Solution**:
- Run diagnostics: `logApiDiagnostics()` in browser console
- Check if required environment variables are set
- Verify `.env` file exists in project root

### Issue: "Access forbidden for [model]"
**Solution**:
- Your API key doesn't have permission for this model
- Contact your API provider to enable access
- Use fallback model or different provider

### Issue: "Rate limit exceeded"
**Solution**:
- Wait and retry after rate limit period
- Upgrade your API plan for higher limits
- Use multiple API keys for load balancing

## Debugging

### Enable Debug Mode
Set in your `.env`:
```env
VITE_DEBUG=true
```

### Check Console Logs
1. Open browser developer tools (F12)
2. Go to Console tab
3. Look for "API Configuration Diagnostics" output
4. Check for detailed error messages

### Manual Diagnostics
In browser console:
```javascript
// Check all configurations
logApiDiagnostics()

// Check specific model
validateModelConfig('gpt-5')

// Get full diagnostics
getApiDiagnostics()
```

## Security Best Practices

1. **Never commit API keys** to version control
2. **Use environment variables** for all sensitive data
3. **Rotate API keys** regularly
4. **Use different keys** for different environments (dev/prod)
5. **Monitor API usage** to detect unauthorized access

## Environment File Security

Add to `.gitignore`:
```
.env
.env.local
.env.production
```

## Fallback Strategy

The system implements automatic fallback:
1. **Primary**: Uses model-specific API keys
2. **Secondary**: Falls back to VITE_API_KEY
3. **Tertiary**: Attempts provider-specific fallbacks

## Need Help?

1. Check browser console for detailed error messages
2. Verify all required environment variables are set
3. Ensure API keys have proper model access
4. Contact your API provider for key verification

## API Provider Documentation

- [APIPlus Documentation](<API_BASE_URL>
- [Moonshot Documentation](https://platform.moonshot.cn/docs)
- [OpenAI Documentation](https://platform.openai.com/docs)
- [Anthropic Documentation](https://docs.anthropic.com/)\n- [Google AI Documentation](https://ai.google.dev/docs)