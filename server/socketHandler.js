const textwaitingUsers = new Map();
const videowaitingUsers = new Map();
const activePairs = new Map();
const activeVideoCalls = new Set();
const userSockets = new Map(); // Track user socket mappings

const SOCKET_RETENTION_TIME = 3 * 60 * 1000;
const MATCH_TIMEOUT = 30000; // 30 seconds timeout for matching

const waitingUsersMap = {
  video: videowaitingUsers,
  text: textwaitingUsers
};

export default (io, socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);
  
  // Store socket reference
  userSockets.set(socket.id, socket);

  socket.on('user-details', ({ gender, interest, name, mode, selectedGender }) => {
    try {
      // Enhanced user data storage
      socket.data = { 
        gender, 
        interest, 
        selectedGender, 
        name, 
        mode,
        joinTime: Date.now(),
        isActive: true
      };
      
      console.log(`[Socket] User ${socket.id} joined with:`, {
        gender,
        interest,
        selectedGender,
        name,
        mode
      });

      // Clean up any existing connections for this socket
      cleanupUserConnections(socket.id);

      const waitingUsers = waitingUsersMap[mode];
      if (!waitingUsers) {
        console.error(`[Socket] Invalid mode: ${mode}`);
        socket.emit('error', { message: 'Invalid chat mode' });
        return;
      }

      // Find best match with improved algorithm
      const matchedSocket = findBestMatch(socket, waitingUsers);

      if (matchedSocket) {
        console.log(`[Socket] Match found: ${socket.id} <-> ${matchedSocket.id}`);
        connectUsers(socket, matchedSocket, mode);
      } else {
        waitingUsers.set(socket.id, socket);
        console.log(`[Socket] User ${socket.id} added to ${mode} waiting list. Total waiting: ${waitingUsers.size}`);
        
        // Set timeout for waiting users
        setTimeout(() => {
          if (waitingUsers.has(socket.id)) {
            console.log(`[Socket] Timeout for user ${socket.id}, removing from waiting list`);
            waitingUsers.delete(socket.id);
            socket.emit('match-timeout', { message: 'No match found, please try again' });
          }
        }, MATCH_TIMEOUT);
      }
    } catch (error) {
      console.error(`[Socket] Error in user-details for ${socket.id}:`, error);
      socket.emit('error', { message: 'Failed to process user details' });
    }
  });

  socket.on('send-message', (message, toSocketId) => {
    try {
      console.log(`[Message] From ${socket.id} to ${toSocketId}: ${message}`);
      
      // Validate message
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        console.log(`[Message] Invalid message from ${socket.id}`);
        return;
      }
      
      // Check if users are actually paired
      const partnerId = activePairs.get(socket.id);
      if (partnerId !== toSocketId) {
        console.log(`[Message] Unauthorized message attempt from ${socket.id} to ${toSocketId}`);
        return;
      }
      
      const target = userSockets.get(toSocketId) || io.sockets.sockets.get(toSocketId);
      if (target && target.connected) {
        target.emit('receive-message', message.trim());
        console.log(`[Message] Delivered to ${toSocketId}`);
      } else {
        console.log(`[Message] Target ${toSocketId} not found or disconnected`);
        socket.emit('partner-disconnected', 'Your partner has disconnected');
      }
    } catch (error) {
      console.error(`[Socket] Error in send-message:`, error);
    }
  });

  socket.on('disconnect-chat', (partnerSocketId, mode) => {
    try {
      console.log(`[Disconnect] ${socket.id} disconnecting from ${partnerSocketId} in ${mode} mode`);
      
      const partnerSocket = userSockets.get(partnerSocketId) || io.sockets.sockets.get(partnerSocketId);

      if (mode === "video") {
        handleVideoCallEnd(socket.id, partnerSocketId);
        socket.emit("end-video");
        if (partnerSocket && partnerSocket.connected) {
          partnerSocket.emit("end-video");
          partnerSocket.emit("find other");
        }
      } else {
        if (partnerSocket && partnerSocket.connected) {
          partnerSocket.emit("disconect", "Partner disconnected.");
          partnerSocket.emit("find other");
        }
      }

      // Clean up the pair
      activePairs.delete(socket.id);
      activePairs.delete(partnerSocketId);
      
      console.log(`[Disconnect] Cleanup completed for ${socket.id} and ${partnerSocketId}`);
    } catch (error) {
      console.error(`[Socket] Error in disconnect-chat:`, error);
    }
  });

  socket.on('next', (partnerSocketId, mode) => {
    try {
      console.log(`[Next] ${socket.id} skipping partner ${partnerSocketId} in ${mode} mode`);
      
      const partnerSocket = userSockets.get(partnerSocketId) || io.sockets.sockets.get(partnerSocketId);
      
      if (mode === "video") {
        handleVideoCallEnd(socket.id, partnerSocketId);
      }
      
      // Clean up the pair
      activePairs.delete(socket.id);
      activePairs.delete(partnerSocketId);
      
      // Notify both users to find new partners
      if (partnerSocket && partnerSocket.connected) {
        console.log(`[Next] Notifying partner ${partnerSocketId} to find other`);
        partnerSocket.emit("find other");
      }
      
      console.log(`[Next] Notifying current user ${socket.id} to find other`);
      socket.emit("find other");
    } catch (error) {
      console.error(`[Socket] Error in next:`, error);
    }
  });

  socket.on('disconnect', (reason) => {
    try {
      console.log(`[Socket] User ${socket.id} disconnected: ${reason}`);
      cleanupUserConnections(socket.id);
      userSockets.delete(socket.id);
    } catch (error) {
      console.error(`[Socket] Error in disconnect:`, error);
    }
  });

  // Enhanced video call signaling events
  socket.on("video-offer", (offer, toSocketId) => {
    try {
      console.log(`[Video] Offer from ${socket.id} to ${toSocketId}`);
      
      // Validate that users are paired
      const partnerId = activePairs.get(socket.id);
      if (partnerId !== toSocketId) {
        console.log(`[Video] Unauthorized offer from ${socket.id} to ${toSocketId}`);
        return;
      }
      
      const target = userSockets.get(toSocketId) || io.sockets.sockets.get(toSocketId);
      if (target && target.connected) {
        target.emit("video-offer", offer, socket.id);
        activeVideoCalls.add(`${socket.id}-${toSocketId}`);
        console.log(`[Video] Offer delivered to ${toSocketId}`);
      } else {
        console.log(`[Video] Target ${toSocketId} not found for offer`);
        socket.emit('partner-disconnected', 'Your partner has disconnected');
      }
    } catch (error) {
      console.error(`[Socket] Error in video-offer:`, error);
    }
  });

  socket.on("video-answer", (answer, toSocketId) => {
    try {
      console.log(`[Video] Answer from ${socket.id} to ${toSocketId}`);
      
      // Validate that users are paired
      const partnerId = activePairs.get(socket.id);
      if (partnerId !== toSocketId) {
        console.log(`[Video] Unauthorized answer from ${socket.id} to ${toSocketId}`);
        return;
      }
      
      const target = userSockets.get(toSocketId) || io.sockets.sockets.get(toSocketId);
      if (target && target.connected) {
        target.emit("video-answer", answer);
        console.log(`[Video] Answer delivered to ${toSocketId}`);
      } else {
        console.log(`[Video] Target ${toSocketId} not found for answer`);
        socket.emit('partner-disconnected', 'Your partner has disconnected');
      }
    } catch (error) {
      console.error(`[Socket] Error in video-answer:`, error);
    }
  });

  socket.on("ice-candidate", (candidate, toSocketId) => {
    try {
      console.log(`[ICE] Candidate from ${socket.id} to ${toSocketId} (type: ${candidate.type || 'unknown'})`);
      
      // Validate that users are paired
      const partnerId = activePairs.get(socket.id);
      if (partnerId !== toSocketId) {
        console.log(`[ICE] Unauthorized ICE candidate from ${socket.id} to ${toSocketId}`);
        return;
      }
      
      const target = userSockets.get(toSocketId) || io.sockets.sockets.get(toSocketId);
      if (target && target.connected) {
        target.emit("ice-candidate", candidate);
        console.log(`[ICE] Candidate delivered to ${toSocketId}`);
      } else {
        console.log(`[ICE] Target ${toSocketId} not found for ICE candidate`);
        socket.emit('partner-disconnected', 'Your partner has disconnected');
      }
    } catch (error) {
      console.error(`[Socket] Error in ice-candidate:`, error);
    }
  });

  socket.on("end-call", (partnerId) => {
    try {
      console.log(`[Video] End call from ${socket.id} to ${partnerId}`);
      
      // Remove from waiting lists
      videowaitingUsers.delete(socket.id);
      
      const partnerSocket = userSockets.get(partnerId) || io.sockets.sockets.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit("end-video");
        partnerSocket.emit("find other");
      }
      
      handleVideoCallEnd(socket.id, partnerId);
      socket.emit("find other");
    } catch (error) {
      console.error(`[Socket] Error in end-call:`, error);
    }
  });

  // Heartbeat mechanism
  socket.on('ping', () => {
    socket.emit('pong');
  });

  // ------------------ Helper Functions ------------------

  function findBestMatch(socket, waitingUsers) {
    console.log(`[Match] Finding match for ${socket.id} with data:`, socket.data);
    
    if (waitingUsers.size === 0) {
      console.log(`[Match] No users waiting in ${socket.data.mode} mode`);
      return null;
    }

    let bestMatch = null;
    let fallbackMatch = null;
    let anyMatch = null;

    for (let [id, otherSocket] of waitingUsers) {
      if (id === socket.id) continue;
      
      // Skip if other socket is not active or doesn't have data
      if (!otherSocket.data || !otherSocket.data.isActive || !otherSocket.connected) {
        console.log(`[Match] Skipping inactive socket ${id}`);
        waitingUsers.delete(id);
        continue;
      }

      const interestsMatch = socket.data.interest && otherSocket.data.interest && 
                           socket.data.interest.toLowerCase() === otherSocket.data.interest.toLowerCase();
      
      const genderMatches = socket.data.selectedGender === "random" || 
                           otherSocket.data.gender === socket.data.selectedGender;
      
      const reverseGenderMatches = otherSocket.data.selectedGender === "random" || 
                                  socket.data.gender === otherSocket.data.selectedGender;

      console.log(`[Match] Checking ${id}: interests=${interestsMatch}, gender=${genderMatches}, reverseGender=${reverseGenderMatches}`);

      // Perfect match: interests match and both gender preferences are satisfied
      if (interestsMatch && genderMatches && reverseGenderMatches) {
        bestMatch = otherSocket;
        break;
      }

      // Good match: either interests match or both gender preferences are satisfied
      if ((interestsMatch) || (genderMatches && reverseGenderMatches)) {
        if (!fallbackMatch) {
          fallbackMatch = otherSocket;
        }
      }

      // Any match: at least one gender preference is satisfied
      if (genderMatches || reverseGenderMatches) {
        if (!anyMatch) {
          anyMatch = otherSocket;
        }
      }
    }

    const selectedMatch = bestMatch || fallbackMatch || anyMatch;
    if (selectedMatch) {
      console.log(`[Match] Selected match ${selectedMatch.id} for ${socket.id}`);
    } else {
      console.log(`[Match] No suitable match found for ${socket.id}`);
    }

    return selectedMatch;
  }

  function connectUsers(socketA, socketB, mode) {
    try {
      const waitingUsers = waitingUsersMap[mode];
      waitingUsers.delete(socketB.id);

      console.log(`[Connect] Connecting ${socketA.id} and ${socketB.id} in ${mode} mode`);

      // Mark both sockets as active in a pair
      socketA.data.isActive = true;
      socketB.data.isActive = true;

      socketA.emit("match-found", { matched: true, socketId: socketB.id });
      socketB.emit("match-found", { matched: true, socketId: socketA.id });

      activePairs.set(socketA.id, socketB.id);
      activePairs.set(socketB.id, socketA.id);

      if (mode === "video") {
        activeVideoCalls.add(`${socketA.id}-${socketB.id}`);
        console.log(`[Video] Video call pair created: ${socketA.id}-${socketB.id}`);
      }

      console.log(`[Connect] Successfully connected ${socketA.id} <-> ${socketB.id}`);
    } catch (error) {
      console.error(`[Socket] Error in connectUsers:`, error);
    }
  }

  function cleanupUserConnections(userId) {
    try {
      console.log(`[Cleanup] Cleaning up connections for user: ${userId}`);
      
      // Remove from waiting lists
      videowaitingUsers.delete(userId);
      textwaitingUsers.delete(userId);

      // Handle active pair cleanup
      const partnerId = activePairs.get(userId);
      if (partnerId) {
        console.log(`[Cleanup] Found active partner ${partnerId} for ${userId}`);
        const partnerSocket = userSockets.get(partnerId) || io.sockets.sockets.get(partnerId);
        if (partnerSocket && partnerSocket.connected) {
          console.log(`[Cleanup] Notifying partner ${partnerId} about disconnection`);
          partnerSocket.emit("disconect", "Partner disconnected unexpectedly.");
          partnerSocket.emit("find other");
        }
        
        // Clean up the pair
        activePairs.delete(userId);
        activePairs.delete(partnerId);
      }

      // Clean up video calls
      const callsToRemove = [];
      for (const callId of activeVideoCalls) {
        if (callId.includes(userId)) {
          callsToRemove.push(callId);
        }
      }
      
      callsToRemove.forEach(callId => {
        activeVideoCalls.delete(callId);
        console.log(`[Cleanup] Removed video call: ${callId}`);
      });

      console.log(`[Cleanup] Cleanup completed for ${userId}`);
    } catch (error) {
      console.error(`[Socket] Error in cleanupUserConnections:`, error);
    }
  }

  function handleVideoCallEnd(userId, partnerId) {
    try {
      console.log(`[Video] Ending video call between ${userId} and ${partnerId}`);
      
      // Remove all possible call combinations
      const callVariations = [
        `${userId}-${partnerId}`,
        `${partnerId}-${userId}`
      ];
      
      callVariations.forEach(callId => {
        if (activeVideoCalls.has(callId)) {
          activeVideoCalls.delete(callId);
          console.log(`[Video] Removed video call: ${callId}`);
        }
      });
      
      // Clean up active pairs
      activePairs.delete(userId);
      activePairs.delete(partnerId);
      
      console.log(`[Video] Video call cleanup completed`);
    } catch (error) {
      console.error(`[Socket] Error in handleVideoCallEnd:`, error);
    }
  }

  // Periodic cleanup of stale connections
  setInterval(() => {
    const now = Date.now();
    
    // Clean up stale waiting users
    [videowaitingUsers, textwaitingUsers].forEach(waitingUsers => {
      for (let [id, socket] of waitingUsers) {
        if (!socket.connected || !socket.data || (now - socket.data.joinTime) > SOCKET_RETENTION_TIME) {
          console.log(`[Cleanup] Removing stale waiting user: ${id}`);
          waitingUsers.delete(id);
        }
      }
    });
    
    // Clean up stale active pairs
    for (let [userId, partnerId] of activePairs) {
      const userSocket = userSockets.get(userId) || io.sockets.sockets.get(userId);
      const partnerSocket = userSockets.get(partnerId) || io.sockets.sockets.get(partnerId);
      
      if (!userSocket || !userSocket.connected || !partnerSocket || !partnerSocket.connected) {
        console.log(`[Cleanup] Removing stale active pair: ${userId} <-> ${partnerId}`);
        activePairs.delete(userId);
        activePairs.delete(partnerId);
      }
    }
  }, 30000); // Run every 30 seconds
};