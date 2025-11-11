#!/bin/bash

echo "Starting Chat App Calling Test Interface..."
echo ""
echo "Make sure your backend server is running on http://localhost:3000"
echo ""

# Try to open in different browsers
if command -v xdg-open > /dev/null; then
    echo "Opening test interface in your default browser..."
    xdg-open test-calling.html
elif command -v open > /dev/null; then
    echo "Opening test interface in your default browser..."
    open test-calling.html
elif command -v start > /dev/null; then
    echo "Opening test interface in your default browser..."
    start test-calling.html
else
    echo "Please open test-calling.html in your browser manually"
fi

echo ""
echo "Test interface opened!"
echo ""
echo "Instructions:"
echo "1. Login or Register with test credentials"
echo "2. Connect to Socket.IO server"
echo "3. Search and select users to chat/call"
echo "4. Test voice and video calling features"
echo ""