// Participant data: single source of truth for names, roles, images and status.
const participants = [
    {
        id: 1,
        name: "Mateo Garcia",
        role: "CEO",
        image: "assets/evernew-male.png",
        online: true
    },
    {
        id: 2,
        name: "Corra Higgins",
        role: "Purchasing Manager",
        image: "assets/evernew-female.png",
        online: true
    }
];

const participantsEl = document.getElementById("participants");
const onlineCountEl = document.getElementById("onlineCountText");
const joinButton = document.getElementById("joinMeetingButton");
const joinText = document.getElementById("joinMeetingText");

function renderParticipants() {
    participantsEl.innerHTML = "";

    participants.forEach((p) => {
        const item = document.createElement("div");
        item.className = "participant";

        const wrapper = document.createElement("div");
        wrapper.className = "avatar-wrapper";

        const img = document.createElement("img");
        img.src = p.image;
        img.alt = p.name;

        const dot = document.createElement("span");
        dot.className = "status-dot" + (p.online ? "" : " offline");

        wrapper.append(img, dot);

        const name = document.createElement("div");
        name.className = "participant-name";
        name.textContent = p.name;

        const role = document.createElement("div");
        role.className = "participant-role";
        role.textContent = p.role;

        item.append(wrapper, name, role);
        participantsEl.appendChild(item);
    });
}

function updateCounts() {
    const participantCount = participants.length;
    const onlineCount = participants.filter((p) => p.online === true).length;

    onlineCountEl.textContent = `${onlineCount} user(s) online`;

    joinText.textContent =
        participantCount > 0
            ? `Join Meeting - ${participantCount} ${participantCount === 1 ? "Participant" : "Participants"}`
            : "Join Meeting";

    joinButton.disabled = participantCount === 0;
}

// Connect real video-calling / navigation logic here.
function handleJoinMeeting() {
  const token = new URLSearchParams(window.location.search).get("token");
  const query = token ? "?token=" + encodeURIComponent(token) : "";
  window.location.href = "page2.html" + query;
}

joinButton.addEventListener("click", handleJoinMeeting);

renderParticipants();
updateCounts();
