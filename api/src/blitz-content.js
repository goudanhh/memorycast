// Instant, human-written practice sets. AI-generated sets are cached in parallel
// for later bursts; a failed AI provider never blocks one-tap training.
const mc=(skill,prompt,choices,answer,evidence,explanation)=>({type:"mcq",skill,prompt,choices,answer,evidence,explanation});
const fill=(skill,prompt,answer,accepted,evidence,explanation)=>({type:"fill",skill,prompt,answer,accepted,evidence,explanation});
export const BLITZ_LIBRARY=[
{topic:"Hotel front desk",title:"A Guest Request",transcript:"Hello, this is Mia in room eight oh five. Could someone bring two extra towels before nine tonight? There is no rush, but please leave them outside the door because my baby is asleep. Thank you.",
 questions:[
 mc("detail","Which room needs assistance?",["805","815","850","508"],"805","room eight oh five","The guest identifies room 805."),
 fill("detail","How many extra towels does Mia request? Enter a number.","2",["2","two"],"two extra towels","She asks for two, not three."),
 mc("intent","Why should staff leave the towels outside?",["The baby is sleeping.","Mia is leaving now.","The room is being cleaned.","The door has no lock."],"The baby is sleeping.","because my baby is asleep","She wants to avoid waking her baby.")
]},
{topic:"Campus announcements",title:"Room Change",transcript:"Attention, students. Today's biology workshop will start at three thirty in room two fourteen, not room two forty. Please bring your notebooks but leave your laptops at home. The instructor wants you to draw diagrams by hand during the session.",
 questions:[
 mc("detail","Where is the biology workshop?",["Room 214","Room 240","Room 204","Room 412"],"Room 214","room two fourteen, not room two forty","The room number is 214, not 240."),
 mc("intent","Why should students leave laptops at home?",["They will draw diagrams by hand.","The building has no electricity.","The computers are broken.","There is an exam online."],"They will draw diagrams by hand.","draw diagrams by hand","The instructor plans a hand-drawing exercise."),
 fill("sound","At what time does the workshop start? Use digits such as 3:30.","3:30",["3:30","15:30","three thirty"],"three thirty","The announced start is 3:30.")
]},
{topic:"Café conversation",title:"At the Coffee Counter",transcript:"Good morning. I'd like a small iced coffee without sugar, please. Actually, could you make it decaf? I've already had too much caffeine today. And can I get it to go? My bus leaves in about ten minutes.",
 questions:[
 mc("detail","What kind of coffee is ordered?",["Small iced decaf coffee","Large hot regular coffee","Small hot espresso","Medium iced tea"],"Small iced decaf coffee","a small iced coffee without sugar","The order is a small iced coffee, later changed to decaf."),
 mc("intent","Why does the customer want decaf?",["They've had too much caffeine.","They dislike cold drinks.","They cannot drink milk.","They need extra energy."],"They've had too much caffeine.","I've already had too much caffeine today","The speaker explicitly wants to avoid more caffeine."),
 fill("detail","About how many minutes until the bus leaves?","10",["10","ten"],"ten minutes","The bus will leave in roughly ten minutes.")
]},
{topic:"Workplace schedule",title:"The Changed Meeting",transcript:"Hi Alex, there's a quick change to tomorrow's team meeting. We were going to meet at eleven, but the manager needs to leave early. Let's start at ten fifteen instead. The agenda is the same: budget first, then next month's staffing plan.",
 questions:[
 mc("detail","What is the new meeting time?",["10:15","11:00","10:50","11:15"],"10:15","Let's start at ten fifteen instead","The meeting is moved earlier to 10:15."),
 mc("gist","What is the main point of the message?",["A meeting time has changed.","A manager has resigned.","The budget has been approved.","The staffing plan was canceled."],"A meeting time has changed.","there's a quick change to tomorrow's team meeting","The speaker is notifying Alex of a schedule change."),
 mc("detail","What will be discussed first?",["The budget","The staffing plan","The location","The holiday schedule"],"The budget","budget first","Budget comes before staffing.")
]},
{topic:"Public transportation",title:"The Late Train",transcript:"Passengers for the northbound train, please listen carefully. Because of repairs near Central Station, the train will depart from platform six instead of platform four. The service is running twelve minutes late. The next stop after departure will still be Riverside.",
 questions:[
 mc("detail","Which platform should passengers use?",["Platform 6","Platform 4","Platform 12","Platform 2"],"Platform 6","platform six instead of platform four","The platform has changed from four to six."),
 fill("detail","How many minutes late is the train?","12",["12","twelve"],"twelve minutes late","The train is delayed by twelve minutes."),
 mc("gist","Which part of the journey has NOT changed?",["The next stop","The departure time","The platform","The repair schedule"],"The next stop","The next stop after departure will still be Riverside","The next stop remains Riverside.")
]},
{topic:"Swimming pool",title:"Pool Safety Notice",transcript:"Hi everyone. The deep end of the pool is closed until two o'clock for maintenance, but the shallow end is open as usual. Please stay behind the blue rope, and ask the lifeguard if you need a kickboard or any help.",
 questions:[
 mc("detail","Which area is closed?",["The deep end","The shallow end","The changing rooms","The entire pool"],"The deep end","The deep end of the pool is closed","Only the deep section is closed."),
 fill("detail","At what hour will the deep end reopen? Use a number.","2",["2","two","14","14:00","2:00"],"until two o'clock","The closure lasts until two o'clock."),
 mc("intent","Why does the speaker mention a blue rope?",["To mark where swimmers must not go","To divide swimming lanes for a race","To indicate water temperature","To reserve space for an event"],"To mark where swimmers must not go","Please stay behind the blue rope","The rope marks the restricted area.")
]},
{topic:"Environmental research",title:"Air Sampling",transcript:"Before collecting the air sample, check that the pump is running at two liters per minute. Then let it run for fifteen minutes. Record the outdoor temperature, because it can affect the measurements. After sampling, seal the container and label it with the time.",
 questions:[
 mc("detail","What flow rate should the pump have?",["2 liters per minute","5 liters per minute","2 liters per hour","15 liters per minute"],"2 liters per minute","two liters per minute","The pump flow rate is two liters per minute."),
 fill("detail","How long should the pump run? Enter minutes.","15",["15","fifteen"],"fifteen minutes","The sampling period is fifteen minutes."),
 mc("inference","Why is outdoor temperature recorded?",["It may influence the measurements.","It determines the label color.","It is needed to start the pump.","It sets the number of containers."],"It may influence the measurements.","because it can affect the measurements","Temperature can influence measured values.")
]},
{topic:"University library",title:"The Reserved Book",transcript:"I checked the online catalog, and the book you need is available, but it's on the reserve shelf. You can borrow it for only two hours. If you need more time, there's a digital copy that you can read from home.",
 questions:[
 mc("detail","How long may the physical book be borrowed?",["Two hours","Two days","One week","Four hours"],"Two hours","only two hours","Reserve-shelf books have a two-hour loan period."),
 mc("inference","What should the student do for longer access?",["Use the digital copy","Return it next month","Ask to buy the shelf","Wait for a printed notice"],"Use the digital copy","there's a digital copy that you can read from home","A digital edition is available for longer reading."),
 fill("detail","Where is the physical book kept? Enter one word.","reserve",["reserve","reserve shelf"],"reserve shelf","The physical copy is on the reserve shelf.")
]},
{topic:"Travel planning",title:"Flight Information",transcript:"Your flight to Seattle has been delayed because of strong winds. Boarding will begin at gate sixteen at six twenty, instead of five fifty. Please keep your boarding pass ready. The airline will make another announcement if the weather changes.",
 questions:[
 mc("detail","Which gate will be used?",["16","60","6","15"],"16","gate sixteen","The announcement says gate sixteen, not sixty."),
 mc("inference","What caused the schedule change?",["Strong winds","A missing passport","A late train","An aircraft upgrade"],"Strong winds","because of strong winds","The delay is weather-related."),
 fill("detail","At what time will boarding begin? Use digits.","6:20",["6:20","18:20","six twenty"],"six twenty","Boarding is scheduled for 6:20.")
]},
{topic:"Team volunteering",title:"Meeting at the Park",transcript:"We're meeting outside the west entrance at eight tomorrow morning to clean up the park. Bring gloves and a reusable water bottle. Please don't bring large bags, since we'll be walking along narrow paths. A coordinator will give us the supplies.",
 questions:[
 mc("detail","Where should volunteers meet?",["West entrance","East entrance","Parking garage","Visitor center"],"West entrance","outside the west entrance","The meeting spot is the west entrance."),
 mc("intent","Why should volunteers avoid large bags?",["The paths are narrow.","All bags are forbidden.","No supplies are needed.","They will ride bicycles."],"The paths are narrow.","we'll be walking along narrow paths","Large bags would be inconvenient on narrow paths."),
 fill("detail","What time should volunteers meet? Use the hour only.","8",["8","eight","8:00","08:00"],"at eight tomorrow morning","The meeting is at eight in the morning.")
]},
{topic:"Museum visit",title:"Audio Guide",transcript:"Welcome to the natural history museum. The new ocean exhibit opens on the second floor at one thirty. You may take photos, but please switch off the flash. If you want an audio guide, pick one up at the desk near the entrance.",
 questions:[
 mc("detail","Where is the new exhibit?",["On the second floor","On the ground floor","Outside the museum","In the basement"],"On the second floor","on the second floor","The ocean exhibit is located on floor two."),
 mc("intent","What should visitors do before taking photos?",["Turn off the flash","Buy a second ticket","Leave their phones at the desk","Ask for a printed guide"],"Turn off the flash","please switch off the flash","Photography is allowed without flash."),
 fill("detail","At what time does the exhibit open? Use digits.","1:30",["1:30","13:30","one thirty"],"at one thirty","The opening time is one thirty.")
]},
{topic:"Hotel booking",title:"A Reservation Change",transcript:"Hello, I'm calling about my reservation for Friday night. Could I check in on Saturday morning instead? I don't need to change the checkout date, which is still Monday. Please send the confirmation to my email address so I can show it at the front desk.",
 questions:[
 mc("gist","What does the caller want to change?",["The check-in date","The number of rooms","The payment method","The checkout date"],"The check-in date","check in on Saturday morning instead","The arrival date changes, not the departure."),
 mc("detail","When will the caller check out?",["Monday","Friday","Saturday","Sunday"],"Monday","which is still Monday","Checkout remains Monday."),
 mc("intent","Why does the caller ask for an email?",["To have proof for the front desk","To cancel the reservation","To receive a discount","To request a room upgrade"],"To have proof for the front desk","so I can show it at the front desk","They want to present confirmation upon arrival.")
]},
{topic:"Academic lecture",title:"Urban Trees",transcript:"Urban trees help cool streets in two ways. Their leaves provide shade, and they release water vapor into the air. But planting a single tree is not enough to cool an entire neighborhood. The location and number of trees matter just as much as the species.",
 questions:[
 mc("gist","What is the lecture mainly about?",["How trees cool cities","How to measure wind speed","Why trees grow taller","The history of farming"],"How trees cool cities","Urban trees help cool streets in two ways","The lecture introduces urban cooling mechanisms."),
 mc("detail","Which process is mentioned besides shading?",["Releasing water vapor","Absorbing road noise","Producing electricity","Storing rainwater"],"Releasing water vapor","they release water vapor into the air","The second mechanism is evaporation."),
 mc("inference","Why would one tree be insufficient?",["Cooling depends on tree distribution and number.","All trees need artificial cooling.","Species never matters.","Trees only work at night."],"Cooling depends on tree distribution and number.","location and number of trees matter","The distribution and density of trees are important.")
]},
{topic:"Phone call",title:"Missed Delivery",transcript:"Hello, this is the delivery office. We tried to bring your package this morning, but nobody answered the door. We can come back tomorrow between ten and noon, or you can collect it from the station today before five. Please call us with your choice.",
 questions:[
 mc("detail","When could the package be delivered again?",["Tomorrow morning","This evening","Next Monday","Tomorrow after five"],"Tomorrow morning","tomorrow between ten and noon","The next delivery window is tomorrow morning."),
 mc("intent","What does the caller want the listener to do?",["Choose a delivery or pickup option","Buy another package","Pay a parking fee","Change the delivery address"],"Choose a delivery or pickup option","Please call us with your choice","The listener must choose among two options."),
 fill("detail","Before which hour can the package be collected today?","5",["5","five","5:00","17:00"],"today before five","Pickup is available before five.")
]},
{topic:"Restaurant booking",title:"A Table for Four",transcript:"I'm sorry, our table by the window is already reserved for seven o'clock. We can offer you a table near the garden at seven thirty, or a window table at eight fifteen. Both are for four people. Which time would you prefer?",
 questions:[
 mc("detail","When is the garden table available?",["7:30","7:00","8:15","8:30"],"7:30","near the garden at seven thirty","The garden table is offered at 7:30."),
 mc("inference","Why are two time options offered?",["The preferred table is already reserved.","The restaurant will close early.","There are only two customers.","Dinner has been canceled."],"The preferred table is already reserved.","already reserved for seven o'clock","The requested table cannot be provided at seven."),
 fill("detail","For how many people are the tables?","4",["4","four"],"for four people","Both options seat four.")
]},
{topic:"Conversation practice",title:"A Change of Plans",transcript:"I was going to take the early bus to the science center, but it's raining heavily. I think I'll wait until the afternoon instead. That gives me time to finish the reading assignment I forgot about yesterday. I still want to visit the center today.",
 questions:[
 mc("gist","What is the speaker planning to do?",["Visit the center later today","Cancel the trip forever","Go to a different city","Skip the reading assignment"],"Visit the center later today","I'll wait until the afternoon instead","They are postponing rather than canceling."),
 mc("inference","What is one benefit of the delay?",["Time to finish the reading assignment","A cheaper entrance ticket","A ride from a classmate","More time to sleep"],"Time to finish the reading assignment","time to finish the reading assignment","The delay frees up study time."),
 mc("detail","Why won't the speaker take the early bus?",["Heavy rain","A missed alarm","A broken phone","A closed science center"],"Heavy rain","it's raining heavily","Rain motivates the change.")
]}
];
